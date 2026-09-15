import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/db/supabase';
import type { User } from '@supabase/supabase-js';
import type { Profile, UserRole } from '@/types/types';

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  return data as Profile | null;
}

interface RegisterPayload {
  username: string;
  password: string;
  full_name?: string;
  role?: UserRole;
  office?: string;
  contact?: string;
}

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  role: UserRole | null;
  loading: boolean;
  signInWithUsername: (username: string, password: string) => Promise<{ error: Error | null }>;
  signUpWithUsername: (payload: RegisterPayload) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = async () => {
    if (!user) { setProfile(null); return; }
    const profileData = await getProfile(user.id);
    setProfile(profileData);
  };

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setUser(session?.user ?? null);
        if (session?.user) getProfile(session.user.id).then(setProfile);
      })
      .finally(() => setLoading(false));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        getProfile(session.user.id).then(setProfile);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithUsername = async (username: string, password: string) => {
    try {
      const email = `${username.toLowerCase()}@ciodesk.com`;
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('is_active')
          .eq('id', session.user.id)
          .single();
        if (profileData && !profileData.is_active) {
          await supabase.auth.signOut();
          throw new Error('Account is deactivated. Contact your administrator.');
        }
      }
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signUpWithUsername = async (payload: RegisterPayload) => {
    try {
      const { data, error } = await supabase.functions.invoke('register-user', {
        body: payload,
        method: 'POST',
      });
      if (error) {
        const msg = await error?.context?.text?.();
        throw new Error(msg || error.message);
      }
      if (data?.error) throw new Error(data.error);
      const email = `${payload.username.toLowerCase()}@ciodesk.com`;
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: payload.password,
      });
      if (signInError) throw signInError;
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{
      user, profile,
      role: profile?.role ?? null,
      loading, signInWithUsername, signUpWithUsername, signOut, refreshProfile
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
