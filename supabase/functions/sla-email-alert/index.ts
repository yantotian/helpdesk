import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ALERT_EMAIL = Deno.env.get("SLA_ALERT_EMAIL") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://app.helpdesk.internal";

async function sendEmail(to: string[], subject: string, html: string) {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured — skipping email");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "IT Helpdesk <alerts@helpdesk.internal>",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
  }
}

function buildAlertHtml(tickets: any[]): string {
  const rows = tickets.map((t) => `
    <tr style="border-bottom:1px solid #333;">
      <td style="padding:8px 12px;font-family:monospace;color:#FF4500;font-weight:bold;">${t.ticket_number}</td>
      <td style="padding:8px 12px;font-family:monospace;color:#e5e7eb;">${t.subject}</td>
      <td style="padding:8px 12px;font-family:monospace;color:${t.priority === 'critical' ? '#FF4500' : '#f59e0b'};text-transform:uppercase;">${t.priority}</td>
      <td style="padding:8px 12px;font-family:monospace;color:#9ca3af;">${t.sla_due_at ? new Date(t.sla_due_at).toUTCString() : 'N/A'}</td>
      <td style="padding:8px 12px;">
        <a href="${APP_URL}/tickets/${t.id}" style="color:#FF4500;font-family:monospace;text-decoration:none;">VIEW →</a>
      </td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#020202;color:#e5e7eb;">
  <div style="max-width:700px;margin:40px auto;background:#0d0d0d;border:1px solid #1f1f1f;">
    <div style="padding:20px 24px;border-bottom:1px solid #FF4500;">
      <span style="font-family:monospace;font-size:10px;color:#FF4500;letter-spacing:4px;text-transform:uppercase;">⚠ SLA BREACH ALERT</span>
    </div>
    <div style="padding:24px;">
      <p style="font-family:monospace;font-size:13px;color:#9ca3af;margin:0 0 20px;">
        The following <strong style="color:#FF4500;">${tickets.length}</strong> ticket(s) have breached SLA thresholds and require immediate attention.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid #FF4500;">
            <th style="padding:8px 12px;font-family:monospace;color:#FF4500;text-align:left;font-size:10px;letter-spacing:2px;">TICKET</th>
            <th style="padding:8px 12px;font-family:monospace;color:#FF4500;text-align:left;font-size:10px;letter-spacing:2px;">SUBJECT</th>
            <th style="padding:8px 12px;font-family:monospace;color:#FF4500;text-align:left;font-size:10px;letter-spacing:2px;">PRIORITY</th>
            <th style="padding:8px 12px;font-family:monospace;color:#FF4500;text-align:left;font-size:10px;letter-spacing:2px;">SLA DUE</th>
            <th style="padding:8px 12px;font-family:monospace;color:#FF4500;text-align:left;font-size:10px;letter-spacing:2px;">ACTION</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #1f1f1f;">
      <p style="font-family:monospace;font-size:10px;color:#6b7280;margin:0;">
        IT HELPDESK SYSTEM · AUTOMATED ALERT · DO NOT REPLY
      </p>
    </div>
  </div>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Fetch breached tickets (critical/high, open, not yet alerted)
  const { data: breachedTickets, error } = await supabase
    .from("tickets")
    .select(`
      id, ticket_number, subject, priority, sla_due_at, assigned_to, status,
      requester:profiles!tickets_requester_id_fkey(email, full_name, username),
      assignee:profiles!tickets_assigned_to_fkey(email, full_name, username)
    `)
    .in("priority", ["critical", "high"])
    .not("status", "in", '("resolved","verified","closed")')
    .eq("sla_alert_sent", false)
    .lt("sla_due_at", new Date().toISOString());

  if (error) {
    console.error("SLA breach query error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!breachedTickets || breachedTickets.length === 0) {
    return new Response(JSON.stringify({ checked: 0, alerted: 0, emails_sent: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const ids = breachedTickets.map((t: any) => t.id);

  // Mark as breached + alert sent
  await supabase
    .from("tickets")
    .update({ sla_breached: true, sla_alert_sent: true })
    .in("id", ids);

  // Log activity for each ticket
  for (const ticket of breachedTickets) {
    await supabase.from("ticket_activities").insert({
      ticket_id: ticket.id,
      actor_id: null,
      activity_type: "system",
      content: `⚠ SLA BREACH: ${ticket.priority.toUpperCase()} ticket overdue since ${new Date(ticket.sla_due_at).toUTCString()}`,
    });
    console.log(`SLA BREACH: ${ticket.ticket_number} [${ticket.priority}]`);
  }

  // Collect unique alert recipients
  const recipients = new Set<string>();

  // Always notify configured alert email
  if (ALERT_EMAIL) recipients.add(ALERT_EMAIL);

  // Notify assigned technicians
  for (const t of breachedTickets) {
    const assigneeEmail = (t as any).assignee?.email;
    if (assigneeEmail) recipients.add(assigneeEmail);
  }

  let emailsSent = 0;
  if (recipients.size > 0) {
    const subject = `[SLA BREACH] ${breachedTickets.length} critical/high ticket(s) overdue`;
    const html = buildAlertHtml(breachedTickets);
    await sendEmail(Array.from(recipients), subject, html);
    emailsSent = recipients.size;
    console.log(`Alert email sent to: ${Array.from(recipients).join(", ")}`);
  }

  return new Response(
    JSON.stringify({
      checked: breachedTickets.length,
      alerted: ids.length,
      emails_sent: emailsSent,
      recipients: Array.from(recipients),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
