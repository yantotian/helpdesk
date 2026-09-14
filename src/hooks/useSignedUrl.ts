import { useEffect, useState } from 'react';
import { getSignedStorageUrl } from '@/lib/api';

export function useSignedUrl(bucket: string, ref: string | null | undefined): string {
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!ref) { setUrl(''); return; }
    let cancelled = false;
    getSignedStorageUrl(bucket, ref)
      .then(u => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setUrl(''); });
    return () => { cancelled = true; };
  }, [bucket, ref]);

  return url;
}
