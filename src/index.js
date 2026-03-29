export default {
  async fetch(request, env) {
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const requestUrl = new URL(request.url);

    console.log("[webhook] request_received", {
      requestId,
      method: request.method,
      path: requestUrl.pathname,
    });

    // 1) Expose a tiny health endpoint so you can quickly verify the worker is online.
    if (request.method === "GET") {
      console.log("[webhook] health_check", { requestId });
      return jsonResponse({ ok: true, service: "email-notify-worker" }, 200);
    }

    // 2) Only accept POST webhooks to reduce accidental or malicious traffic patterns.
    if (request.method !== "POST") {
      console.warn("[webhook] method_not_allowed", {
        requestId,
        method: request.method,
      });
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    // 3) Read auth headers provided by your webhook trigger system.
    const incomingSecret = request.headers.get("x-webhook-secret");
    const incomingSource = request.headers.get("x-webhook-source");

    // 4) Fail fast if worker secrets are not configured at deploy/runtime.
    if (!env.WEBHOOK_SECRET || !env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) {
      console.error("[webhook] missing_worker_env", { requestId });
      return jsonResponse(
        { error: "Worker env is missing required secrets or vars." },
        500
      );
    }

    // 5) Enforce shared-secret auth so only trusted producers can call this endpoint.
    if (!incomingSecret || incomingSecret !== env.WEBHOOK_SECRET) {
      console.warn("[webhook] unauthorized_secret", { requestId });
      return jsonResponse({ error: "Unauthorized webhook secret." }, 401);
    }

    // 6) Optionally enforce a known source marker to prevent cross-system spoofing.
    if (env.WEBHOOK_SOURCE && incomingSource !== env.WEBHOOK_SOURCE) {
      console.warn("[webhook] invalid_source", {
        requestId,
        incomingSource,
        expectedSource: env.WEBHOOK_SOURCE,
      });
      return jsonResponse({ error: "Invalid webhook source." }, 401);
    }

    let payload;
    try {
      // 7) Parse JSON body and return a clean 400 when malformed content is sent.
      payload = await request.json();
    } catch {
      console.warn("[webhook] invalid_json", { requestId });
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }

    // 8) Support your schema while handling optional key variations safely.
    const {
      title,
      description,
      module_id: moduleId,
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
      console.warn("[webhook] no_valid_recipients", { requestId });
      return jsonResponse({ error: "No valid email recipients found." }, 400);
    }

    console.log("[webhook] payload_validated", {
      requestId,
      moduleId: moduleId || "N/A",
      moduleCode: moduleCode || "N/A",
      moduleName: moduleName || "Unknown Module",
      isKuppi,
      recipients: normalizedRecipients.length,
    });

    // 10) Build subject/content using provided lecture/module metadata.
    const safeTitle = title || "New Learning Update";
    const safeModuleCode = moduleCode || "N/A";
    const safeModuleId = moduleId ? String(moduleId).trim() : "";
    const safeModuleName = moduleName || "Unknown Module";
    const safeDescription = description || "A new notification is available.";

    const subject = isKuppi
      ? `New Kuppi Added | ${safeModuleName}`
      : `New Kuppi Material Added | ${safeModuleName}`;
    const htmlContent = buildHtml({
      title: safeTitle,
      moduleId: safeModuleId,
      moduleCode: safeModuleCode,
      moduleName: safeModuleName,
      description: safeDescription,
      videoId,
      isKuppi,
      languageCode,
    });

    // 11) Send one Brevo request using messageVersions (one recipient per version).
    const messageVersions = normalizedRecipients.map((recipient) => ({
      to: [
        {
          email: recipient.email,
          ...(recipient.name ? { name: recipient.name } : {}),
        },
      ],
    }));

    const brevoPayload = {
      sender: {
        email: env.BREVO_SENDER_EMAIL,
        name: env.BREVO_SENDER_NAME || "KuppiHub",
      },
      to: [
        {
          email: normalizedRecipients[0].email,
          ...(normalizedRecipients[0].name ? { name: normalizedRecipients[0].name } : {}),
        },
      ],
      subject,
      htmlContent,
      messageVersions,
    };

    let brevoRes;
    try {
      console.log("[brevo] sending_batch", {
        requestId,
        versions: messageVersions.length,
      });

      brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": env.BREVO_API_KEY,
        },
        body: JSON.stringify(brevoPayload),
      });
    } catch (error) {
      console.error("[brevo] network_error", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });

      return jsonResponse(
        {
          error: "Brevo API network error.",
        },
        502
      );
    }

    const brevoText = await brevoRes.text();
    const brevoJson = safeJsonParse(brevoText);

    console.log("[brevo] response_received", {
      requestId,
      status: brevoRes.status,
      ok: brevoRes.ok,
    });

    if (!brevoRes.ok) {
      console.error("[brevo] request_failed", {
        requestId,
        status: brevoRes.status,
        details: trimForLog(brevoText, 500),
      });

      return jsonResponse(
        {
          error: "Brevo API request failed.",
          status: brevoRes.status,
          details: brevoText,
        },
        502
      );
    }

    const messageIds = Array.isArray(brevoJson?.messageIds)
      ? brevoJson.messageIds
      : brevoJson?.messageId
        ? [brevoJson.messageId]
        : [];

    console.log("[webhook] batch_result", {
      requestId,
      sent: normalizedRecipients.length,
      messageIds: messageIds.length,
    });

    return jsonResponse(
      {
        ok: true,
        sent_to: normalizedRecipients.length,
        recipients: normalizedRecipients.map((recipient) => recipient.email),
        message_ids: messageIds,
        brevo_response: brevoJson,
      },
      200
    );
  },
};

function buildHtml({
  title,
  moduleId,
  moduleCode,
  moduleName,
  description,
  videoId,
  isKuppi,
  languageCode,
}) {
  // Logic for Dynamic Theme
  const headerColor = isKuppi ? "#1e3a8a" : "#0f172a"; 
  const label = isKuppi ? "KUPPI" : "MODULE";
  const icon = isKuppi ? "🎓" : "📘";
  const videoUrl = `https://kuppihub.org/video/${moduleId}`;

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${label}Hub Notification</title>
</head>
<body style="margin:0; padding:0; background-color:#f3f4f6; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">

    <div style="display:none !important; visibility:hidden; mso-hide:all; font-size:1px; color:#f3f4f6; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
        ${title} for ${moduleName} (${moduleCode}). ${description}.
        &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
    </div>

    <table align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:20px auto; background:#ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow:hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        
        <tr>
            <td style="background-color:${headerColor}; padding:25px; text-align:center;">
                <h1 style="color:#ffffff; margin:0; font-size:20px; letter-spacing:2px; font-weight: bold; text-transform: uppercase;">
                    ${label} HUB NOTIFICATION
                </h1>
            </td>
        </tr>
        
        <tr>
            <td style="padding:40px 30px;">
                <p style="font-size:16px; color:#334155; line-height:1.6; margin-top:0;">Hello Student,</p>
                <p style="font-size:16px; color:#334155; line-height:1.6;">
                    A new <strong>${isKuppi ? "Kuppi Session" : "Academic Lesson"}</strong> has been added for <strong>${moduleName}</strong>. Make sure to check it out and continue your learning journey. Staying consistent will help you get the most out of your course!.
                </p>

                <div style="margin:30px 0; padding:20px; background-color:#f8fafc; border-left:4px solid ${headerColor}; border-radius:4px;">
                    <h3 style="margin:0 0 15px 0; color:${headerColor}; font-size:18px;">${isKuppi ? "Session" : "Update"} Highlights:</h3>
                    <table width="100%" style="font-size:15px; color:#475569; line-height:1.8; border-collapse: collapse;">
                        <tr>
                            <td style="width:100px; font-weight:bold; padding: 4px 0; vertical-align: top;">Title:</td>
                            <td style="padding: 4px 0;">${title}</td>
                        </tr>
                        <tr>
                            <td style="font-weight:bold; padding: 4px 0; vertical-align: top;">Module:</td>
                            <td style="padding: 4px 0;">${moduleName} (${moduleCode})</td>
                        </tr>
                        <tr>
                            <td style="font-weight:bold; padding: 4px 0; vertical-align: top;">Language:</td>
                            <td style="padding: 4px 0;">${languageCode.toUpperCase()}</td>
                        </tr>
                        <tr>
                            <td style="font-weight:bold; padding: 4px 0; vertical-align: top;">Description:</td>
                            <td style="padding: 4px 0;">${description}</td>
                        </tr>
                    </table>
                </div>

                <p style="font-size:14px; color:#64748b; margin-bottom:30px; font-style: italic;">
                    <strong>⏳ Friendly reminder:</strong>  This might look optional now… until exam night when it suddenly becomes very important 👀.
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

function trimForLog(text, maxLength = 500) {
  const value = String(text ?? "");
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
