import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { switchUserCart } from "@/lib/cart";

export interface UnifiedUser {
  id: string;
  uid?: string;
  email: string | null;
  phoneNumber?: string | null;
  phone?: string | null;
  displayName?: string | null;
  full_name?: string | null;
  role?: string;
  isAdmin?: boolean;
}

type AuthContextValue = {
  session: { user: UnifiedUser } | null;
  user: UnifiedUser | null;
  firebaseUser: User | null;
  /** True only after the server has verified this Firebase sign-in as an administrator. */
  isAdmin: boolean;
  /** True while the first sign-in state, or an admin check, is still being resolved. */
  loading: boolean;
  signOut: () => Promise<void>;
  setCustomerSession: (customer: UnifiedUser) => void;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  firebaseUser: null,
  isAdmin: false,
  loading: true,
  signOut: async () => {},
  setCustomerSession: () => {},
});

const readCustomerSession = (): UnifiedUser | null => {
  try {
    const saved = localStorage.getItem("awh_customer_session") || sessionStorage.getItem("awh_customer_session");
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (parsed && (parsed.email || parsed.phone || parsed.phoneNumber || parsed.id || parsed.uid)) {
      // A stored customer record can never grant admin rights.
      return { ...parsed, role: "customer", isAdmin: false };
    }
  } catch {
    /* ignore */
  }
  return null;
};

/**
 * Admin rights come from the server only: it verifies the Firebase ID token and checks the
 * admin claim / allowlist. Nothing stored in the browser can make someone an admin.
 */
const verifyAdminWithServer = async (currUser: User): Promise<boolean> => {
  try {
    const idToken = await currUser.getIdToken();
    const res = await fetch("/api/admin/verify-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.authorized === true;
  } catch (err) {
    console.warn("Admin verification note:", err);
    return false;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  // Customer session is restored synchronously so customers do not see a logout flicker.
  const [user, setUser] = useState<UnifiedUser | null>(() => (typeof window === "undefined" ? null : readCustomerSession()));
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  // Customer session setter (persists across tab closes, page reloads, and app reopens)
  const setCustomerSession = useCallback((customer: UnifiedUser) => {
    const cleanEmail = (customer.email || "").trim().toLowerCase();
    const unified: UnifiedUser = {
      ...customer,
      id: customer.id || customer.uid || `cust_${Date.now()}`,
      uid: customer.uid || customer.id || `cust_${Date.now()}`,
      email: cleanEmail || customer.email || null,
      displayName: customer.displayName || customer.full_name || cleanEmail.split("@")[0] || "Customer",
      role: "customer",
      isAdmin: false,
    };

    try {
      localStorage.setItem("awh_customer_session", JSON.stringify(unified));
      sessionStorage.setItem("awh_customer_session", JSON.stringify(unified));
      if (unified.id) {
        localStorage.setItem("awh_customer_id", unified.id);
      }
    } catch {
      /* ignore */
    }

    setUser(unified);
    setLoading(false);
    switchUserCart(unified.email || unified.id);
  }, []);

  useEffect(() => {
    let active = true;

    // Sessions left behind by the removed password-only admin login are never honoured.
    try {
      for (const store of [localStorage, sessionStorage]) {
        store.removeItem("awh_admin_token");
        store.removeItem("awh_admin_session");
      }
    } catch {
      /* ignore */
    }

    const unsubscribe = onAuthStateChanged(auth, async (currUser) => {
      if (!active) return;
      setFirebaseUser(currUser);

      if (currUser) {
        const unified: UnifiedUser = {
          id: currUser.uid,
          uid: currUser.uid,
          email: currUser.email,
          phoneNumber: currUser.phoneNumber,
          displayName: currUser.displayName || currUser.email?.split("@")[0] || "Customer",
          role: "customer",
          isAdmin: false,
        };
        setUser(unified);
        try {
          localStorage.setItem("awh_customer_session", JSON.stringify(unified));
          sessionStorage.setItem("awh_customer_session", JSON.stringify(unified));
        } catch {
          /* ignore */
        }
        switchUserCart(unified.email || unified.id);

        // Keep the page in its loading state until the server has answered.
        setIsAdmin(false);
        const admin = await verifyAdminWithServer(currUser);
        if (!active) return;
        setIsAdmin(admin);
      } else {
        setIsAdmin(false);
        // No Firebase sign-in: fall back to the stored customer session, if any (unchanged behaviour).
        const stored = readCustomerSession();
        if (stored) {
          setUser(stored);
          switchUserCart(stored.email || stored.id || stored.uid);
        } else {
          setUser(null);
          switchUserCart("guest");
        }
      }
      setLoading(false);
    });

    // Never leave the app on a spinner if Firebase is unreachable.
    const timer = window.setTimeout(() => {
      if (active) setLoading(false);
    }, 4000);

    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fbSignOut(auth);
    } catch (e) {
      console.warn("Firebase signout error:", e);
    }
    try {
      sessionStorage.removeItem("awh_customer_session");
      localStorage.removeItem("awh_customer_session");
      localStorage.removeItem("awh_customer_id");
    } catch {
      /* ignore */
    }
    setUser(null);
    setFirebaseUser(null);
    setIsAdmin(false);
    switchUserCart("guest");
  }, []);

  const session = user ? { user } : null;

  return (
    <AuthContext.Provider value={{ session, user, firebaseUser, isAdmin, loading, signOut, setCustomerSession }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
