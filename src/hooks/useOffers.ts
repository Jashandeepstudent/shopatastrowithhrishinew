import { useCallback, useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";

export type PromoOffer = {
  id: string;
  title: string;
  description?: string | null;
  discount_text?: string | null;
  image_url?: string | null;
  active?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  created_at?: string;
};

// Visible unless explicitly deactivated, and within its start/end window when set.
const isLive = (o: PromoOffer) => {
  if (o.active === false) return false;
  const now = Date.now();
  if (o.starts_at && new Date(o.starts_at).getTime() > now) return false;
  if (o.ends_at) {
    // ends_at is stored as a date (admin picks a day, not a time); treat it as
    // inclusive through the end of that day rather than midnight at its start.
    const end = new Date(o.ends_at);
    end.setHours(23, 59, 59, 999);
    if (end.getTime() < now) return false;
  }
  return true;
};

/** Public-facing "offers" collection — promo banners shown on the live site. */
export const useOffers = () => {
  const [offers, setOffers] = useState<PromoOffer[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, "offers"));
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as PromoOffer[];
      const live = rows.filter(isLive);
      live.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      setOffers(live);
    } catch (err) {
      console.warn("Offers load warning:", err);
      setOffers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { offers, loading, reload: load };
};
