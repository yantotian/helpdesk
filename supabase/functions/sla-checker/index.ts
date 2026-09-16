import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Find tickets approaching or past SLA threshold — also mark near-breach tickets
  const now = new Date().toISOString();
  const soonThreshold = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hr ahead

  // Mark newly breached tickets and return their IDs
  const { data: newlyBreached } = await supabase
    .from("tickets")
    .update({ sla_breached: true })
    .in("priority", ["critical", "high"])
    .not("status", "in", '("resolved","verified","closed")')
    .lt("sla_due_at", now)
    .eq("sla_breached", false)
    .select("id, ticket_number, requester_id, assigned_to");

  // Create in-app notifications for newly breached tickets
  if (newlyBreached && newlyBreached.length > 0) {
    const notifications: Array<{
      user_id: string;
      ticket_id: string;
      type: string;
      title: string;
      body: string;
    }> = [];

    for (const t of newlyBreached) {
      const title = "SLA breach";
      const body = `Ticket ${t.ticket_number} has breached its SLA threshold.`;

      if (t.requester_id) {
        notifications.push({
          user_id: t.requester_id, ticket_id: t.id,
          type: "sla_breach", title, body,
        });
      }
      if (t.assigned_to && t.assigned_to !== t.requester_id) {
        notifications.push({
          user_id: t.assigned_to, ticket_id: t.id,
          type: "sla_breach", title, body,
        });
      }
    }

    if (notifications.length > 0) {
      await supabase.from("notifications").insert(notifications);
    }
  }

  // Check if there are new breach alerts to send
  const { data: pendingAlerts, error } = await supabase
    .from("tickets")
    .select("id, ticket_number, subject, priority, sla_due_at")
    .in("priority", ["critical", "high"])
    .not("status", "in", '("resolved","verified","closed")')
    .eq("sla_alert_sent", false)
    .lt("sla_due_at", now);

  if (error) {
    console.error("SLA check error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (!pendingAlerts || pendingAlerts.length === 0) {
    console.log("SLA check: no new breaches");
    return new Response(JSON.stringify({ checked: 0, alerted: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Delegate email sending to the dedicated email alert function
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    const emailRes = await fetch(`${supabaseUrl}/functions/v1/sla-email-alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
    });
    const emailData = await emailRes.json();
    console.log("Email alert result:", JSON.stringify(emailData));
    return new Response(JSON.stringify(emailData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e: any) {
    console.error("Failed to invoke sla-email-alert:", e.message);
    return new Response(JSON.stringify({ checked: pendingAlerts.length, alerted: 0, email_error: e.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
