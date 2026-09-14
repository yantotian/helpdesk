import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { ticket_id } = await req.json();
    if (!ticket_id) {
      return new Response(JSON.stringify({ error: "ticket_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Check config
    const { data: cfg } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "auto_assign_enabled")
      .single();

    if (cfg?.value !== "true") {
      return new Response(JSON.stringify({ assigned: false, reason: "auto_assign_disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Find least-busy active technician (active non-closed/verified ticket count)
    const { data: technicians } = await supabase
      .from("profiles")
      .select("id, full_name, username")
      .eq("role", "technician")
      .eq("is_active", true);

    if (!technicians || technicians.length === 0) {
      console.log("No technicians available for auto-assignment");
      return new Response(JSON.stringify({ assigned: false, reason: "no_technicians" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Count active tickets per technician
    const workloadMap: Record<string, { count: number; lastAssigned: string | null }> = {};
    for (const tech of technicians) {
      workloadMap[tech.id] = { count: 0, lastAssigned: null };
    }

    const { data: activeTickets } = await supabase
      .from("tickets")
      .select("assigned_to, updated_at")
      .in("assigned_to", technicians.map((t: any) => t.id))
      .not("status", "in", '("closed","verified")');

    if (activeTickets) {
      for (const t of activeTickets) {
        if (t.assigned_to && workloadMap[t.assigned_to]) {
          workloadMap[t.assigned_to].count++;
          workloadMap[t.assigned_to].lastAssigned = t.updated_at;
        }
      }
    }

    // Sort by count ASC, then lastAssigned ASC (earlier = less recently assigned)
    const sorted = technicians.sort((a: any, b: any) => {
      const wa = workloadMap[a.id];
      const wb = workloadMap[b.id];
      if (wa.count !== wb.count) return wa.count - wb.count;
      const da = wa.lastAssigned ? new Date(wa.lastAssigned).getTime() : 0;
      const db = wb.lastAssigned ? new Date(wb.lastAssigned).getTime() : 0;
      return da - db;
    });

    const assignedTech = sorted[0];

    // Update ticket
    await supabase
      .from("tickets")
      .update({ assigned_to: assignedTech.id, status: "assigned", updated_at: new Date().toISOString() })
      .eq("id", ticket_id);

    // Log activity
    await supabase.from("ticket_activities").insert({
      ticket_id,
      actor_id: assignedTech.id,
      activity_type: "assignment",
      content: `Auto-assigned to ${assignedTech.full_name || assignedTech.username}`,
      new_value: assignedTech.id,
    });

    return new Response(
      JSON.stringify({ assigned: true, technician_id: assignedTech.id, technician: assignedTech.full_name || assignedTech.username }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
