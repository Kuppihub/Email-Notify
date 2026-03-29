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
  // Dynamic settings based on content type
  const headerColor = isKuppi ? "#1e3a8a" : "#0f172a"; // Blue for Kuppi, Dark for Module
  const label = isKuppi ? "KUPPI" : "MODULE";
  const icon = isKuppi ? "🎓" : "📘";
  const videoUrl = `https://kuppihub.org/module-kuppi/${videoId}`;

  return `<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f3f4f6; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    <table align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:20px auto; background:#ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow:hidden;">
        <tr>
            <td style="background-color:${headerColor}; padding:25px; text-align:center;">
                <h1 style="color:#ffffff; margin:0; font-size:20px; letter-spacing:2px; font-weight: bold;">
                    ${icon} ${label}HUB NOTIFICATION
                </h1>
            </td>
        </tr>
        
        <tr>
            <td style="padding:40px 30px;">
                <p style="font-size:16px; color:#334155; line-height:1.6; margin-top:0;">Hello Student,</p>
                <p style="font-size:16px; color:#334155; line-height:1.6;">
                    A new <strong>${isKuppi ? "Kuppi Session" : "Academic Lesson"}</strong> has been released for your module. Please review the details below and watch the video to stay updated with your coursework.
                </p>

                <div style="margin:30px 0; padding:20px; background-color:#f8fafc; border-left:4px solid ${headerColor}; border-radius:4px;">
                    <h3 style="margin:0 0 15px 0; color:${headerColor}; font-size:18px;">${isKuppi ? "Session" : "Update"} Highlights:</h3>
                    <table width="100%" style="font-size:15px; color:#475569; line-height:1.8;">
                        <tr><td style="width:100px; font-weight:bold;">Title:</td><td>${title}</td></tr>
                        <tr><td style="font-weight:bold;">Module:</td><td>${moduleName} (${moduleCode})</td></tr>
                        <tr><td style="font-weight:bold;">Language:</td><td>${languageCode.toUpperCase()}</td></tr>
                        <tr><td style="font-weight:bold;">Description:</td><td>${description}</td></tr>
                    </table>
                </div>

                <p style="font-size:14px; color:#64748b; margin-bottom:30px; font-style: italic;">
                    <strong>Note:</strong> We recommend watching this as soon as possible to ensure you are prepared for your upcoming assessments.
                </p>

                <div style="text-align:center; margin-bottom: 10px;">
                    <a href="${videoUrl}" style="background-color:#2563eb; color:#ffffff; padding:16px 40px; text-decoration:none; border-radius:6px; font-weight:bold; display:inline-block; font-size:16px; box-shadow: 0 4px 6px rgba(37, 99, 235, 0.2);">
                        ▶ Watch Video Now
                    </a>
                </div>
            </td>
        </tr>

        <tr>
            <td style="background-color:#f9fafb; padding:25px; text-align:center; border-top: 1px solid #e5e7eb;">
                <p style="margin:0; font-size:12px; color:#94a3b8; line-height: 1.5;">
                    This is an automated notification from <strong>KuppiHub</strong>.<br>
                    You are receiving this because you are enrolled in ${moduleCode}.
                </p>
                <div style="margin-top:15px; font-size:12px;">
                    <a href="https://kuppihub.org/privacy" style="color:#2563eb; text-decoration:none;">Privacy Policy</a>
                    <span style="color:#e2e8f0; margin:0 10px;">|</span>
                    <a href="https://kuppihub.org/contact" style="color:#2563eb; text-decoration:none;">Support Center</a>
                </div>
            </td>
        </tr>
    </table>
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
