export default {
  async fetch(request, env) {
    // 1) Expose a tiny health endpoint so you can quickly verify the worker is online.
    if (request.method === "GET") {
      return jsonResponse({ ok: true, service: "email-notify-worker" }, 200);
    }

    // 2) Only accept POST webhooks to reduce accidental or malicious traffic patterns.
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    // 3) Read auth headers provided by your webhook trigger system.
    const incomingSecret = request.headers.get("x-webhook-secret");
    const incomingSource = request.headers.get("x-webhook-source");

    // 4) Fail fast if worker secrets are not configured at deploy/runtime.
    if (!env.WEBHOOK_SECRET || !env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) {
      return jsonResponse(
        { error: "Worker env is missing required secrets or vars." },
        500
      );
    }

    // 5) Enforce shared-secret auth so only trusted producers can call this endpoint.
    if (!incomingSecret || incomingSecret !== env.WEBHOOK_SECRET) {
      return jsonResponse({ error: "Unauthorized webhook secret." }, 401);
    }

    // 6) Optionally enforce a known source marker to prevent cross-system spoofing.
    if (env.WEBHOOK_SOURCE && incomingSource !== env.WEBHOOK_SOURCE) {
      return jsonResponse({ error: "Invalid webhook source." }, 401);
    }

    let payload;
    try {
      // 7) Parse JSON body and return a clean 400 when malformed content is sent.
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }

    // 8) Support your schema while handling optional key variations safely.
    const {
      title,
      description,
      module_code: moduleCode,
      module_name: moduleName,
      video_id: videoId,
      emails,
      emails_list: emailsList,
      is_kuppi: isKuppiSnake,
    } = payload;

    const isKuppi = payload["is-kuppi"] ?? isKuppiSnake ?? false;
    const languageCode = payload["language_code"] ?? payload["language-code"] ?? "en";

    // 9) Normalize recipients from both emails_list (preferred) and emails (fallback).
    const normalizedRecipients = normalizeRecipients({ emailsList, emails });

    if (normalizedRecipients.length === 0) {
      return jsonResponse({ error: "No valid email recipients found." }, 400);
    }

    // 10) Build subject/content using provided lecture/module metadata.
    const safeTitle = title || "New Learning Update";
    const safeModuleCode = moduleCode || "N/A";
    const safeModuleName = moduleName || "Unknown Module";
    const safeDescription = description || "A new notification is available.";

    const subject = isKuppi
      ? `📢 New Kuppi Added | ${safeModuleCode}`
      : `📘 New Update | ${safeModuleCode}`;
    const htmlContent = buildHtml({
      title: safeTitle,
      moduleCode: safeModuleCode,
      moduleName: safeModuleName,
      description: safeDescription,
      videoId,
      isKuppi,
      languageCode,
    });

    // 11) Map emails into Brevo recipient objects (name is optional).
    const to = normalizedRecipients.map((recipient) => ({
      email: recipient.email,
      ...(recipient.name ? { name: recipient.name } : {}),
    }));

    const brevoPayload = {
      sender: {
        email: env.BREVO_SENDER_EMAIL,
        name: env.BREVO_SENDER_NAME || "KuppiHub",
      },
      to,
      subject,
      htmlContent,
    };

    // 12) Send one API request to Brevo and forward useful diagnostics on failure.
    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
      body: JSON.stringify(brevoPayload),
    });

    const brevoText = await brevoRes.text();

    if (!brevoRes.ok) {
      return jsonResponse(
        {
          error: "Brevo API request failed.",
          status: brevoRes.status,
          details: brevoText,
        },
        502
      );
    }

    // 13) Respond with summary details to confirm recipients were processed.
    return jsonResponse(
      {
        ok: true,
        sent_to: normalizedRecipients.length,
        recipients: normalizedRecipients.map((recipient) => recipient.email),
        brevo_response: safeJsonParse(brevoText),
      },
      200
    );
  },
};

function buildHtml({
  title,
  moduleCode,
  moduleName,
  description,
  videoId,
  isKuppi,
  languageCode,
}) {
  return `<!DOCTYPE html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
    <h2 style="margin-bottom: 8px;">${isKuppi ? "🎓 New Kuppi Added" : "📘 New Module Update"}</h2>
    <p style="margin: 0 0 12px;">A new ${isKuppi ? "Kuppi" : "lesson update"} has been added for this module. Please go and watch it.</p>
    <p style="margin: 0 0 12px;"><strong>Title:</strong> ${escapeHtml(title)}</p>
    <p style="margin: 0 0 12px;"><strong>Module:</strong> ${escapeHtml(moduleName)} (${escapeHtml(moduleCode)})</p>
    <p style="margin: 0 0 12px;"><strong>Description:</strong> ${escapeHtml(description)}</p>
    <p style="margin: 0 0 12px;"><strong>Video ID:</strong> ${escapeHtml(String(videoId ?? "N/A"))}</p>
    <p style="margin: 0 0 12px;"><strong>Language:</strong> ${escapeHtml(languageCode)}</p>
    <p style="margin: 0 0 12px;"><strong>Kuppi Session:</strong> ${isKuppi ? "Yes" : "No"}</p>
    <hr style="margin: 20px 0; border: 0; border-top: 1px solid #e5e7eb;" />
    <p style="margin: 0; font-size: 12px; color: #6b7280;">This is an automated notification from KuppiHub.</p>
  </body>
</html>`;
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function normalizeRecipients({ emailsList, emails }) {
  const recipientsByEmail = new Map();

  if (Array.isArray(emailsList)) {
    for (const entry of emailsList) {
      const email = String(entry?.email ?? "").trim().toLowerCase();
      const name = String(entry?.name ?? "").trim();

      if (!isValidEmail(email)) {
        continue;
      }

      recipientsByEmail.set(email, {
        email,
        ...(name ? { name } : {}),
      });
    }
  }

  if (Array.isArray(emails)) {
    for (const value of emails) {
      const email = String(value ?? "").trim().toLowerCase();

      if (!isValidEmail(email) || recipientsByEmail.has(email)) {
        continue;
      }

      recipientsByEmail.set(email, { email });
    }
  }

  return [...recipientsByEmail.values()];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
