import { supabase } from '@/db/supabase';
import type { Ticket, TicketActivity, TicketAttachment, Profile, Category, PriorityConfig, SystemConfig, TicketFilters, TicketStatus, AppNotification, TicketTemplate } from '@/types/types';

// ──────────────────────────────────────────────
// Profiles
// ──────────────────────────────────────────────
export async function getProfile(id: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return data;
}

export async function updateProfile(id: string, updates: Partial<Profile>) {
  const { error } = await supabase.from('profiles').update(updates).eq('id', id);
  if (error) throw error;
}

export async function getProfiles(role?: string) {
  let q = supabase.from('profiles').select('*').eq('is_active', true).order('full_name');
  if (role) q = q.eq('role', role);
  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getAllProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function updateProfileRole(id: string, role: string) {
  const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
  if (error) throw error;
}

export async function toggleProfileActive(id: string, is_active: boolean) {
  const { error } = await supabase.from('profiles').update({ is_active }).eq('id', id);
  if (error) throw error;
}

// ──────────────────────────────────────────────
// Categories
// ──────────────────────────────────────────────
export async function getCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('sort_order')
    .limit(200);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function upsertCategory(cat: Partial<Category>) {
  if (cat.id) {
    const { error } = await supabase.from('categories').update(cat).eq('id', cat.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('categories').insert(cat);
    if (error) throw error;
  }
}

export async function deactivateCategory(id: string) {
  const { error } = await supabase.from('categories').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

export async function deleteCategory(id: string) {
  // Null out any tickets referencing this category to avoid FK violation
  await supabase.from('tickets').update({ category_id: null }).eq('category_id', id);
  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) throw error;
}

// ──────────────────────────────────────────────
// ID Requests
// ──────────────────────────────────────────────
const toHex = (s: string) =>
  Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

async function uploadIDFile(bucket: string, userId: string, file: File): Promise<string> {
  const dot = file.name.lastIndexOf('.');
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const ext  = dot > 0 ? file.name.slice(dot) : '';
  const safeName = `${userId}/${Date.now()}_${toHex(stem)}${ext}`;
  const { data, error } = await supabase.storage.from(bucket).upload(safeName, file, { contentType: file.type, upsert: true });
  if (error) throw error;
  return data.path;
}

export function getStoragePathFromRef(bucketOrRef: string, ref?: string): string {
  const value = ref ?? bucketOrRef;
  if (!value.startsWith('http')) return value;
  const marker = `/object/`;
  const idx = value.indexOf(marker);
  if (idx === -1) return value;
  const rest = value.slice(idx + marker.length);
  const slashIdx = rest.indexOf('/');
  return slashIdx === -1 ? rest : rest.slice(slashIdx + 1);
}

export async function getSignedStorageUrl(bucket: string, ref: string): Promise<string> {
  const path = getStoragePathFromRef(bucket, ref);
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw error ?? new Error('Failed to create signed URL');
  return data.signedUrl;
}

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || 'image/png' });
}

export async function submitIDRequest(payload: {
  office_name: string; full_name: string; nickname: string; id_number: string;
  position: string; address: string;
  emergency_name: string; emergency_contact: string; emergency_address: string;
  photoFile?: File | null; signatureDataUrl?: string | null;
  userId: string;
}): Promise<void> {
  let photo_url: string | null = null;
  let signature_url: string | null = null;
  if (payload.photoFile) {
    photo_url = await uploadIDFile('id-photos', payload.userId, payload.photoFile);
  }
  if (payload.signatureDataUrl) {
    const sigFile = await dataUrlToFile(payload.signatureDataUrl, 'signature.png');
    signature_url = await uploadIDFile('id-signatures', payload.userId, sigFile);
  }
  const { error } = await supabase.from('id_requests').insert({
    office_name: payload.office_name,
    full_name: payload.full_name,
    nickname: payload.nickname || null,
    id_number: payload.id_number,
    position: payload.position,
    address: payload.address,
    emergency_name: payload.emergency_name,
    emergency_contact: payload.emergency_contact,
    emergency_address: payload.emergency_address,
    photo_url,
    signature_url,
  });
  if (error) throw error;
}

export async function getIDRequests(page = 0, limit = 50) {
  const from = page * limit;
  const { data, error } = await supabase
    .from('id_requests')
    .select('*, requester:profiles!requester_id(id,full_name,username,office)')
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function getMyIDRequests() {
  const { data, error } = await supabase
    .from('id_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function updateIDRequestStatus(id: string, status: string, notes?: string) {
  const { error } = await supabase.from('id_requests').update({ status, notes: notes || null }).eq('id', id);
  if (error) throw error;
}

export async function updateIDRequestPayment(id: string, is_paid: boolean) {
  const { error } = await supabase.from('id_requests').update({ is_paid }).eq('id', id);
  if (error) throw error;
}

// ── ICT Inventory ─────────────────────────────────────────────────────────────
import type { ICTDevice, ICTInternet } from '@/types/types';

export async function getICTDevices(type?: string) {
  let q = supabase.from('ict_devices').select('*').order('created_at', { ascending: false });
  if (type && type !== 'all') q = q.eq('device_type', type);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ICTDevice[];
}

export async function createICTDevice(payload: Partial<ICTDevice>) {
  const { data, error } = await supabase.from('ict_devices').insert(payload).select().single();
  if (error) throw error;
  return data as ICTDevice;
}

export async function updateICTDevice(id: string, payload: Partial<ICTDevice>) {
  const { data, error } = await supabase.from('ict_devices').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data as ICTDevice;
}

export async function deleteICTDevice(id: string) {
  const { error } = await supabase.from('ict_devices').delete().eq('id', id);
  if (error) throw error;
}

export async function getICTInternet() {
  const { data, error } = await supabase
    .from('ict_internet')
    .select('*, router:router_id(id,brand,model)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ICTInternet[];
}

export async function createICTInternet(payload: Partial<ICTInternet>) {
  const { data, error } = await supabase.from('ict_internet').insert(payload).select().single();
  if (error) throw error;
  return data as ICTInternet;
}

export async function updateICTInternet(id: string, payload: Partial<ICTInternet>) {
  const { data, error } = await supabase.from('ict_internet').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data as ICTInternet;
}

export async function deleteICTInternet(id: string) {
  const { error } = await supabase.from('ict_internet').delete().eq('id', id);
  if (error) throw error;
}

// ── Speed Test Logs ──────────────────────────────────────────────────────────
import type { SpeedTestLog, DeviceTicketLink } from '@/types/types';

export async function getSpeedTestLogs(internetId: string) {
  const { data, error } = await supabase
    .from('speed_test_logs')
    .select('*, tester:tested_by(id,full_name,username)')
    .eq('internet_id', internetId)
    .order('tested_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SpeedTestLog[];
}

export async function createSpeedTestLog(payload: {
  internet_id: string;
  dl_mbps: number;
  ul_mbps?: number | null;
  latency_ms?: number | null;
  notes?: string | null;
  tested_at?: string;
}) {
  const { data, error } = await supabase
    .from('speed_test_logs')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as SpeedTestLog;
}

export async function deleteSpeedTestLog(id: string) {
  const { error } = await supabase.from('speed_test_logs').delete().eq('id', id);
  if (error) throw error;
}

export async function getAllSpeedTestLogs() {
  const { data, error } = await supabase
    .from('speed_test_logs')
    .select('*, internet:internet_id(id,location,isp_name)')
    .order('tested_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as (SpeedTestLog & { internet?: { id: string; location: string; isp_name: string } })[];
}

// ── Device-Ticket Links ───────────────────────────────────────────────────────
export async function getDeviceTicketLinks(deviceId: string) {
  const { data, error } = await supabase
    .from('device_ticket_links')
    .select('*, ticket:ticket_id(id,ticket_number,subject,status,priority), linker:linked_by(id,full_name,username)')
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DeviceTicketLink[];
}

export async function createDeviceTicketLink(payload: {
  device_id: string;
  ticket_id: string;
  note?: string | null;
}) {
  const { data, error } = await supabase
    .from('device_ticket_links')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as DeviceTicketLink;
}

export async function deleteDeviceTicketLink(id: string) {
  const { error } = await supabase.from('device_ticket_links').delete().eq('id', id);
  if (error) throw error;
}

export async function searchTickets(query: string) {
  const { data, error } = await supabase
    .from('tickets')
    .select('id,ticket_number,subject,status,priority')
    .or(`ticket_number.ilike.%${query}%,subject.ilike.%${query}%`)
    .limit(20);
  if (error) throw error;
  return (data ?? []) as Pick<import('@/types/types').Ticket, 'id' | 'ticket_number' | 'subject' | 'status' | 'priority'>[];
}

// ── ICT Inventory Submissions ─────────────────────────────────────────────────
import type { ICTInventorySubmission } from '@/types/types';

export async function getMySubmissions() {
  const { data, error } = await supabase
    .from('ict_inventory_submissions')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ICTInventorySubmission[];
}

export async function getAllSubmissions() {
  const { data, error } = await supabase
    .from('ict_inventory_submissions')
    .select('*, submitter:submitted_by(id,full_name,username), reviewer:reviewed_by(id,full_name,username)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ICTInventorySubmission[];
}

export async function createInventorySubmission(payload: Omit<ICTInventorySubmission,
  'id' | 'status' | 'admin_note' | 'reviewed_by' | 'reviewed_at' | 'created_at' | 'submitter' | 'reviewer'
>) {
  const { data, error } = await supabase
    .from('ict_inventory_submissions')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as ICTInventorySubmission;
}

export async function reviewInventorySubmission(id: string, status: 'approved' | 'rejected', admin_note?: string) {
  const { data, error } = await supabase
    .from('ict_inventory_submissions')
    .update({ status, admin_note: admin_note ?? null, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as ICTInventorySubmission;
}

export async function getIDRequestCount(): Promise<number> {
  const { count, error } = await supabase.from('id_requests').select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function deleteTicket(id: string) {
  // Remove dependent rows first to satisfy FK constraints
  await supabase.from('ticket_activities').delete().eq('ticket_id', id);
  await supabase.from('ticket_attachments').delete().eq('ticket_id', id);
  const { error } = await supabase.from('tickets').delete().eq('id', id);
  if (error) throw error;
}

export async function updateCategorySortOrders(items: { id: string; sort_order: number }[]) {
  for (const item of items) {
    const { error } = await supabase.from('categories').update({ sort_order: item.sort_order }).eq('id', item.id);
    if (error) throw error;
  }
}

// ──────────────────────────────────────────────
// Priority Config
// ──────────────────────────────────────────────
export async function getPriorityConfigs(): Promise<PriorityConfig[]> {
  const { data, error } = await supabase
    .from('priority_config')
    .select('*')
    .order('sla_hours');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function updatePriorityConfig(id: string, updates: Partial<PriorityConfig>) {
  const { error } = await supabase.from('priority_config').update(updates).eq('id', id);
  if (error) throw error;
}

// ──────────────────────────────────────────────
// System Config
// ──────────────────────────────────────────────
export async function getSystemConfigs(): Promise<SystemConfig[]> {
  const { data, error } = await supabase.from('system_config').select('*').order('key');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function updateSystemConfig(key: string, value: string) {
  const { error } = await supabase
    .from('system_config')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key);
  if (error) throw error;
}

// ──────────────────────────────────────────────
// Tickets
// ──────────────────────────────────────────────
const TICKET_SELECT = `
  *,
  requester:profiles!tickets_requester_id_fkey(id,username,full_name,office,contact,role),
  assignee:profiles!tickets_assigned_to_fkey(id,username,full_name,role),
  category:categories!tickets_category_id_fkey(id,name),
  subcategory:categories!tickets_subcategory_id_fkey(id,name)
`;

export async function getTickets(filters: TicketFilters = {}, page = 0, limit = 25): Promise<Ticket[]> {
  let q = supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);
  if (filters.priority && filters.priority !== 'all') q = q.eq('priority', filters.priority);
  if (filters.category_id && filters.category_id !== 'all') q = q.eq('category_id', filters.category_id);
  if (filters.assigned_to && filters.assigned_to !== 'all') q = q.eq('assigned_to', filters.assigned_to);
  if (filters.office) q = q.ilike('office', `%${filters.office}%`);
  if (filters.date_from) q = q.gte('created_at', filters.date_from);
  if (filters.date_to) q = q.lte('created_at', filters.date_to);
  if (filters.search) {
    q = q.or(`subject.ilike.%${filters.search}%,ticket_number.ilike.%${filters.search}%`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? (data as unknown as Ticket[]) : [];
}

export async function getMyTickets(userId: string, filters: TicketFilters = {}, page = 0): Promise<Ticket[]> {
  return getTickets({ ...filters, assigned_to: undefined }, page, 25).then(tickets =>
    tickets.filter(t => t.requester_id === userId)
  );
}

export async function getAssignedTickets(userId: string, filters: TicketFilters = {}, page = 0): Promise<Ticket[]> {
  return getTickets({ ...filters, assigned_to: userId }, page, 25);
}

export async function getTicket(id: string): Promise<Ticket | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as Ticket | null;
}

export async function getTicketByNumber(ticketNumber: string): Promise<Ticket | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .eq('ticket_number', ticketNumber)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as Ticket | null;
}

export async function createTicket(payload: Partial<Ticket>): Promise<string> {
  // Convert empty strings to null
  const clean: Record<string, unknown> = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, v === '' ? null : v])
  );
  const { data, error } = await supabase.from('tickets').insert(clean as any).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function updateTicket(id: string, updates: Partial<Ticket>) {
  const clean: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).map(([k, v]) => [k, v === '' ? null : v])
  );
  const { error } = await supabase.from('tickets').update(clean as any).eq('id', id);
  if (error) throw error;
}

export async function updateTicketStatus(
  ticketId: string,
  newStatus: TicketStatus,
  actorId: string,
  oldStatus: TicketStatus,
  note?: string
) {
  const updates: Partial<Ticket> = { status: newStatus };
  if (newStatus === 'resolved') updates.resolved_at = new Date().toISOString();

  await updateTicket(ticketId, updates);

  await supabase.from('ticket_activities').insert({
    ticket_id: ticketId,
    actor_id: actorId,
    activity_type: 'status_change',
    content: note || `Status changed to ${newStatus.replace('_', ' ')}`,
    old_value: oldStatus,
    new_value: newStatus,
  });
}

export async function assignTicket(ticketId: string, techId: string, actorId: string) {
  await updateTicket(ticketId, { assigned_to: techId, status: 'assigned' });
  await supabase.from('ticket_activities').insert({
    ticket_id: ticketId,
    actor_id: actorId,
    activity_type: 'assignment',
    content: `Ticket assigned`,
    new_value: techId,
  });
}

export async function bulkAssignTickets(ticketIds: string[], techId: string, actorId: string) {
  // Only assign tickets that are still new/unassigned
  const { error } = await supabase
    .from('tickets')
    .update({ assigned_to: techId, status: 'assigned' })
    .in('id', ticketIds)
    .in('status', ['new']);
  if (error) throw error;

  const activities = ticketIds.map(id => ({
    ticket_id: id,
    actor_id: actorId,
    activity_type: 'assignment',
    content: 'Bulk assigned by admin',
    new_value: techId,
  }));
  await supabase.from('ticket_activities').insert(activities);
}

// ──────────────────────────────────────────────
// Activities
// ──────────────────────────────────────────────
export async function getActivities(ticketId: string): Promise<TicketActivity[]> {
  const { data, error } = await supabase
    .from('ticket_activities')
    .select('*, actor:profiles!ticket_activities_actor_id_fkey(id,username,full_name,role)')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return Array.isArray(data) ? (data as unknown as TicketActivity[]) : [];
}

export async function addComment(ticketId: string, actorId: string, content: string) {
  const { error } = await supabase.from('ticket_activities').insert({
    ticket_id: ticketId,
    actor_id: actorId,
    activity_type: 'comment',
    content,
  });
  if (error) throw error;
}

// ──────────────────────────────────────────────
// Attachments
// ──────────────────────────────────────────────
export async function getAttachments(ticketId: string): Promise<TicketAttachment[]> {
  const { data, error } = await supabase
    .from('ticket_attachments')
    .select('*, uploader:profiles!ticket_attachments_uploader_id_fkey(id,username,full_name)')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return Array.isArray(data) ? (data as unknown as TicketAttachment[]) : [];
}

export async function uploadAttachment(ticketId: string, uploaderId: string, file: File) {
  const safeName = file.name.toLowerCase().replace(/\s+/g, '_');
  const path = `${ticketId}/${Date.now()}_${safeName}`;
  const { data: uploaded, error: uploadErr } = await supabase.storage
    .from('ticket-attachments')
    .upload(path, file, { contentType: file.type });
  if (uploadErr) throw uploadErr;

  const { error } = await supabase.from('ticket_attachments').insert({
    ticket_id: ticketId,
    uploader_id: uploaderId,
    file_name: file.name,
    file_path: uploaded.path,
    file_size: file.size,
    mime_type: file.type,
  });
  if (error) throw error;

  await supabase.from('ticket_activities').insert({
    ticket_id: ticketId,
    actor_id: uploaderId,
    activity_type: 'attachment',
    content: `Attachment uploaded: ${file.name}`,
    new_value: uploaded.path,
  });
}

export async function getAttachmentUrl(path: string): Promise<string> {
  return getSignedStorageUrl('ticket-attachments', path);
}

// ──────────────────────────────────────────────
// Dashboard / Reports
// ──────────────────────────────────────────────
export async function getDashboardStats(userId?: string, role?: string) {
  let q = supabase.from('tickets').select('status,priority,sla_breached,assigned_to,requester_id');
  if (role === 'requester' && userId) q = q.eq('requester_id', userId);
  else if (role === 'technician' && userId) q = q.eq('assigned_to', userId);

  const { data, error } = await q.limit(5000);
  if (error) throw error;
  const tickets = Array.isArray(data) ? data : [];

  const by_status: Record<string, number> = {};
  const by_priority: Record<string, number> = {};
  let sla_breached = 0;
  let open = 0;

  for (const t of tickets) {
    by_status[t.status] = (by_status[t.status] || 0) + 1;
    by_priority[t.priority] = (by_priority[t.priority] || 0) + 1;
    if (t.sla_breached) sla_breached++;
    if (!['closed', 'verified'].includes(t.status)) open++;
  }

  return { total: tickets.length, by_status, by_priority, sla_breached, open };
}

export async function getTechnicianWorkload() {
  const { data: techs } = await supabase
    .from('profiles')
    .select('id,full_name,username')
    .eq('role', 'technician')
    .eq('is_active', true);

  if (!techs) return [];

  const { data: active } = await supabase
    .from('tickets')
    .select('assigned_to')
    .not('status', 'in', '("closed","verified")');

  const countMap: Record<string, number> = {};
  (active || []).forEach((t: any) => {
    if (t.assigned_to) countMap[t.assigned_to] = (countMap[t.assigned_to] || 0) + 1;
  });

  return techs.map((t: any) => ({ ...t, active_tickets: countMap[t.id] || 0 }));
}

export async function getRecentActivity(limit = 20) {
  const { data, error } = await supabase
    .from('ticket_activities')
    .select('*, actor:profiles!ticket_activities_actor_id_fkey(username,full_name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

// ──────────────────────────────────────────────
// Notifications
// ──────────────────────────────────────────────
export async function getNotifications(userId: string, limit = 30): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*, ticket:tickets(id,ticket_number,subject)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? (data as unknown as AppNotification[]) : [];
}

export async function getUnreadCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) return 0;
  return count ?? 0;
}

export async function markNotificationRead(id: string) {
  await supabase.from('notifications').update({ is_read: true }).eq('id', id);
}

export async function markAllNotificationsRead(userId: string) {
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
}

// ──────────────────────────────────────────────
// Ticket Templates
// ──────────────────────────────────────────────
const TEMPLATE_SELECT = `*, category:categories!ticket_templates_category_id_fkey(id,name), subcategory:categories!ticket_templates_subcategory_id_fkey(id,name)`;

export async function getTicketTemplates(activeOnly = true): Promise<TicketTemplate[]> {
  let q = supabase.from('ticket_templates').select(TEMPLATE_SELECT).order('name');
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? (data as unknown as TicketTemplate[]) : [];
}

export async function upsertTicketTemplate(t: Partial<TicketTemplate>): Promise<void> {
  const clean: Record<string, unknown> = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v === '' ? null : v]));
  if (t.id) {
    const { error } = await supabase.from('ticket_templates').update({ ...clean, updated_at: new Date().toISOString() } as any).eq('id', t.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('ticket_templates').insert(clean as any);
    if (error) throw error;
  }
}

export async function deleteTicketTemplate(id: string) {
  const { error } = await supabase.from('ticket_templates').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

// ──────────────────────────────────────────────
// Global Search
// ──────────────────────────────────────────────
export interface SearchResult {
  type: 'ticket' | 'user' | 'category';
  id: string;
  label: string;
  sub: string;
  path: string;
}

export async function globalSearch(q: string): Promise<SearchResult[]> {
  if (!q.trim() || q.length < 2) return [];
  const term = q.trim();

  const [ticketsRes, usersRes, catsRes] = await Promise.all([
    supabase
      .from('tickets')
      .select('id,ticket_number,subject,status,priority')
      .or(`ticket_number.ilike.%${term}%,subject.ilike.%${term}%`)
      .limit(8),
    supabase
      .from('profiles')
      .select('id,username,full_name,role')
      .or(`username.ilike.%${term}%,full_name.ilike.%${term}%`)
      .limit(5),
    supabase
      .from('categories')
      .select('id,name,parent_id')
      .ilike('name', `%${term}%`)
      .eq('is_active', true)
      .limit(5),
  ]);

  const results: SearchResult[] = [];

  for (const t of (ticketsRes.data ?? [])) {
    results.push({
      type: 'ticket',
      id: t.id,
      label: t.ticket_number,
      sub: t.subject,
      path: `/tickets/${t.id}`,
    });
  }
  for (const u of (usersRes.data ?? [])) {
    results.push({
      type: 'user',
      id: u.id,
      label: u.full_name || u.username,
      sub: `@${u.username} · ${u.role}`,
      path: `/admin/users`,
    });
  }
  for (const c of (catsRes.data ?? [])) {
    results.push({
      type: 'category',
      id: c.id,
      label: c.name,
      sub: c.parent_id ? 'Subcategory' : 'Category',
      path: `/admin/categories`,
    });
  }

  return results;
}
