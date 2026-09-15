import { useEffect, useRef, useState } from 'react';
import MainLayout from '@/components/layouts/MainLayout';
import { getAllProfiles, toggleProfileActive } from '@/lib/api';
import { supabase } from '@/db/supabase';
import type { Profile, UserRole } from '@/types/types';
import { Button } from '@/components/ui/button';
import { formatUtc8DateStamp } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { RefreshCw, Search, UserCheck, UserX, Pencil, Trash2, UserPlus, Eye, EyeOff, Download, Upload } from 'lucide-react';

const ROLES: UserRole[] = ['requester', 'technician', 'it_admin', 'sysadmin'];
const ROLE_LABELS: Record<UserRole, string> = {
  requester: 'Requester', technician: 'Technician', it_admin: 'IT Admin', sysadmin: 'SysAdmin',
};

interface EditForm {
  username: string;
  full_name: string;
  role: UserRole;
  office: string;
  contact: string;
  password: string;
}

const EMPTY_EDIT: EditForm = { username: '', full_name: '', role: 'requester', office: '', contact: '', password: '' };

// ── Password strength ───────────────────────────────────────────────────────
function getPasswordStrength(pw: string): { score: number; label: string; color: string } {
  if (!pw) return { score: 0, label: '', color: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score, label: 'Weak', color: 'bg-red-500' };
  if (score === 2) return { score, label: 'Fair', color: 'bg-orange-400' };
  if (score === 3) return { score, label: 'Good', color: 'bg-yellow-400' };
  return { score, label: 'Strong', color: 'bg-green-500' };
}

function PasswordStrengthBar({ password }: { password: string }) {
  const { score, label, color } = getPasswordStrength(password);
  if (!password) return null;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${score >= i ? color : 'bg-muted'}`} />
        ))}
      </div>
      <p className={`text-xs font-medium ${score <= 1 ? 'text-red-500' : score === 2 ? 'text-orange-400' : score === 3 ? 'text-yellow-500' : 'text-green-500'}`}>
        {label}
      </p>
    </div>
  );
}

// ── Edge function helper ────────────────────────────────────────────────────
async function callManage(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('admin-user-manage', { body });
  if (error) {
    const msg = await error?.context?.text().catch(() => null);
    try { const parsed = JSON.parse(msg ?? ''); throw new Error(parsed.error ?? msg); } catch { throw new Error(msg ?? error.message); }
  }
  return data;
}

// ── CSV helpers ─────────────────────────────────────────────────────────────
function exportToCSV(profiles: Profile[]) {
  const headers = ['username', 'full_name', 'email', 'role', 'office', 'contact', 'is_active', 'created_at'];
  const rows = profiles.map(p => [
    p.username, p.full_name ?? '', p.email ?? '', p.role,
    p.office ?? '', p.contact ?? '', p.is_active ? 'true' : 'false',
    p.created_at.slice(0, 10),
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `users_${formatUtc8DateStamp(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map(line => {
    // simple CSV parse — handles basic quoted fields
    const vals: string[] = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else { cur += ch; }
    }
    vals.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

export default function UsersPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Profile | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_EDIT);
  const [showPw, setShowPw] = useState(false);

  // Add dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<EditForm & { confirmPw: string }>({ ...EMPTY_EDIT, confirmPw: '' });
  const [showAddPw, setShowAddPw] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);

  // CSV import
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvImporting, setCsvImporting] = useState(false);

  const reload = async () => {
    setLoading(true);
    getAllProfiles().then(setProfiles).finally(() => setLoading(false));
  };
  useEffect(() => { reload(); }, []);

  const filtered = profiles.filter(p =>
    !search ||
    p.username.toLowerCase().includes(search.toLowerCase()) ||
    (p.full_name || '').toLowerCase().includes(search.toLowerCase())
  );

  // ── Toggle active ──────────────────────────────────────────────
  const handleToggle = async (user: Profile) => {
    setSaving(user.id);
    try {
      await toggleProfileActive(user.id, !user.is_active);
      setProfiles(p => p.map(u => u.id === user.id ? { ...u, is_active: !u.is_active } : u));
      toast.success(user.is_active ? 'User deactivated' : 'User activated');
    } catch (e: any) { toast.error(e.message); }
    setSaving(null);
  };

  // ── Open edit dialog ───────────────────────────────────────────
  const openEdit = (u: Profile) => {
    setEditTarget(u);
    setEditForm({ username: u.username, full_name: u.full_name || '', role: u.role, office: u.office || '', contact: u.contact || '', password: '' });
    setShowPw(false);
    setEditOpen(true);
  };

  // ── Save edit ──────────────────────────────────────────────────
  const handleEditSave = async () => {
    if (!editTarget) return;
    setSaving(editTarget.id);
    try {
      const patch: Record<string, unknown> = {
        action: 'update', user_id: editTarget.id,
        username: editForm.username.trim() || undefined,
        full_name: editForm.full_name.trim() || undefined,
        role: editForm.role,
        office: editForm.office.trim() || undefined,
        contact: editForm.contact.trim() || undefined,
      };
      if (editForm.password) patch.password = editForm.password;
      await callManage(patch);
      toast.success('User updated');
      setEditOpen(false);
      reload();
    } catch (e: any) { toast.error(e.message); }
    setSaving(null);
  };

  // ── Add new user ───────────────────────────────────────────────
  const handleAddSave = async () => {
    if (!addForm.username.trim() || !addForm.password) { toast.error('Username and password are required'); return; }
    if (addForm.password !== addForm.confirmPw) { toast.error('Passwords do not match'); return; }
    setSaving('new');
    try {
      const { data, error } = await supabase.functions.invoke('register-user', {
        body: {
          username: addForm.username.trim(),
          password: addForm.password,
          full_name: addForm.full_name.trim() || addForm.username.trim(),
          role: addForm.role,
          office: addForm.office.trim() || undefined,
          contact: addForm.contact.trim() || undefined,
        },
      });
      if (error) {
        const msg = await error?.context?.text().catch(() => null);
        try { const parsed = JSON.parse(msg ?? ''); throw new Error(parsed.error ?? msg); } catch { throw new Error(msg ?? error.message); }
      }
      if (data?.error) throw new Error(data.error);
      toast.success('User created');
      setAddOpen(false);
      setAddForm({ ...EMPTY_EDIT, confirmPw: '' });
      reload();
    } catch (e: any) { toast.error(e.message); }
    setSaving(null);
  };

  // ── Delete user ────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(deleteTarget.id);
    try {
      await callManage({ action: 'delete', user_id: deleteTarget.id });
      toast.success('User deleted');
      setDeleteTarget(null);
      reload();
    } catch (e: any) { toast.error(e.message); }
    setSaving(null);
  };

  // ── CSV Import ─────────────────────────────────────────────────
  const handleCSVImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length === 0) { toast.error('No valid rows found in CSV'); return; }

    setCsvImporting(true);
    let success = 0, failed = 0;
    for (const row of rows) {
      const username = (row['username'] || '').trim();
      const password = (row['password'] || '').trim();
      if (!username || !password) { failed++; continue; }
      try {
        const { data, error } = await supabase.functions.invoke('register-user', {
          body: {
            username,
            password,
            full_name: row['full_name'] || username,
            role: ROLES.includes(row['role'] as UserRole) ? row['role'] : 'requester',
            office: row['office'] || undefined,
            contact: row['contact'] || undefined,
          },
        });
        if (error || data?.error) { failed++; } else { success++; }
      } catch { failed++; }
    }
    setCsvImporting(false);
    toast.success(`Import done: ${success} created, ${failed} failed`);
    reload();
  };

  return (
    <MainLayout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="laser-line mb-2 w-20" />
            <h1 className="text-xl font-bold text-foreground">User Management</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{profiles.length} total users</p>
          </div>
          <div className="flex items-center flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={reload} className="border border-border text-xs">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={() => exportToCSV(profiles)}
              className="border border-border text-xs" title="Export all users as CSV">
              <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
            </Button>
            <Button size="sm" variant="ghost" onClick={() => csvInputRef.current?.click()}
              disabled={csvImporting} className="border border-border text-xs" title="Bulk-create users from CSV">
              <Upload className="w-3.5 h-3.5 mr-1.5" /> {csvImporting ? 'Importing…' : 'Import CSV'}
            </Button>
            <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={handleCSVImport} />
            <Button size="sm" onClick={() => { setAddForm({ ...EMPTY_EDIT, confirmPw: '' }); setShowAddPw(false); setAddOpen(true); }}
              className="text-xs">
              <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Add User
            </Button>
          </div>
        </div>

        {/* CSV format hint */}
        <p className="text-xs text-muted-foreground">
          CSV import columns: <span className="font-mono">username, password, full_name, role, office, contact</span>
          {' '}— <code className="font-mono">username</code> and <code className="font-mono">password</code> are required.
        </p>

        {/* Search */}
        <div className="relative w-full md:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by username or name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>

        {/* Table */}
        <div className="border border-border bg-card rounded-sm min-w-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['Username', 'Full Name', 'Office', 'Role', 'Status', 'Joined', 'Actions'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-muted-foreground">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-muted-foreground">No users found</td></tr>
                ) : filtered.map(u => (
                  <tr key={u.id} className={`border-b border-border/50 hover:bg-secondary/40 transition-colors ${!u.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2.5 whitespace-nowrap text-sm font-medium text-primary">{u.username}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-sm text-foreground">{u.full_name || '—'}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-sm text-muted-foreground">{u.office || '—'}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="inline-block text-xs font-medium px-2 py-0.5 rounded border border-border bg-secondary text-secondary-foreground">
                        {ROLE_LABELS[u.role]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        u.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${u.is_active ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{u.created_at.slice(0, 10)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(u)} disabled={saving === u.id}
                          className="h-7 w-7 p-0 border border-border" title="Edit user">
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleToggle(u)} disabled={saving === u.id}
                          className="h-7 px-2 border border-border text-xs" title={u.is_active ? 'Deactivate' : 'Activate'}>
                          {u.is_active ? <UserX className="w-3 h-3" /> : <UserCheck className="w-3 h-3" />}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(u)} disabled={saving === u.id}
                          className="h-7 w-7 p-0 border border-border text-destructive hover:text-destructive" title="Delete user">
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Edit User Dialog ─────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Edit User — {editTarget?.username}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Username</Label>
                <Input value={editForm.username} onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))}
                  className="h-9 text-sm" placeholder="username" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Full Name</Label>
                <Input value={editForm.full_name} onChange={e => setEditForm(f => ({ ...f, full_name: e.target.value }))}
                  className="h-9 text-sm" placeholder="Full name" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">New Password <span className="text-muted-foreground font-normal">(leave blank to keep current)</span></Label>
              <div className="relative">
                <Input type={showPw ? 'text' : 'password'} value={editForm.password}
                  onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))}
                  className="h-9 text-sm pr-10" placeholder="New password" />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <PasswordStrengthBar password={editForm.password} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Role</Label>
                <Select value={editForm.role} onValueChange={v => setEditForm(f => ({ ...f, role: v as UserRole }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Office</Label>
                <Input value={editForm.office} onChange={e => setEditForm(f => ({ ...f, office: e.target.value }))}
                  className="h-9 text-sm" placeholder="Office / dept." />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Contact</Label>
              <Input value={editForm.contact} onChange={e => setEditForm(f => ({ ...f, contact: e.target.value }))}
                className="h-9 text-sm" placeholder="Phone / ext." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} className="text-sm">Cancel</Button>
            <Button onClick={handleEditSave} disabled={saving === editTarget?.id} className="text-sm">
              {saving === editTarget?.id ? 'Saving…' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add User Dialog ──────────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Add New User</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Username <span className="text-destructive">*</span></Label>
                <Input value={addForm.username} onChange={e => setAddForm(f => ({ ...f, username: e.target.value }))}
                  className="h-9 text-sm" placeholder="e.g. john_doe" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Full Name</Label>
                <Input value={addForm.full_name} onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
                  className="h-9 text-sm" placeholder="John Doe" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Password <span className="text-destructive">*</span></Label>
                <div className="relative">
                  <Input type={showAddPw ? 'text' : 'password'} value={addForm.password}
                    onChange={e => setAddForm(f => ({ ...f, password: e.target.value }))}
                    className="h-9 text-sm pr-10" placeholder="Min 6 characters" />
                  <button type="button" onClick={() => setShowAddPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showAddPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <PasswordStrengthBar password={addForm.password} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Confirm Password <span className="text-destructive">*</span></Label>
                <Input type="password" value={addForm.confirmPw}
                  onChange={e => setAddForm(f => ({ ...f, confirmPw: e.target.value }))}
                  className="h-9 text-sm" placeholder="Repeat password" />
                {addForm.confirmPw && addForm.password !== addForm.confirmPw && (
                  <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Role</Label>
                <Select value={addForm.role} onValueChange={v => setAddForm(f => ({ ...f, role: v as UserRole }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Office</Label>
                <Input value={addForm.office} onChange={e => setAddForm(f => ({ ...f, office: e.target.value }))}
                  className="h-9 text-sm" placeholder="Office / dept." />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Contact</Label>
              <Input value={addForm.contact} onChange={e => setAddForm(f => ({ ...f, contact: e.target.value }))}
                className="h-9 text-sm" placeholder="Phone / ext." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} className="text-sm">Cancel</Button>
            <Button onClick={handleAddSave} disabled={saving === 'new'} className="text-sm">
              {saving === 'new' ? 'Creating…' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirm ───────────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={o => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user "{deleteTarget?.username}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the user account and all associated auth data. Tickets created by this user will remain. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
