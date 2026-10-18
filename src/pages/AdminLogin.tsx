import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, sendPasswordResetEmail, signOut as fbSignOut } from "firebase/auth";
import { ShieldCheck, Lock, Eye, EyeOff, Mail, ArrowLeft } from "lucide-react";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { auth } from "@/lib/firebase";
import { toast } from "sonner";

const AdminLogin = () => {
  const { isAdmin, loading } = useAuth();
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  useEffect(() => {
    document.title = "Admin Sign In | Astro With Hrishi";
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-10 w-10 rounded-full border-2 border-gold/30 border-t-gold animate-spin" />
      </div>
    );
  }

  if (isAdmin) return <Navigate to="/admin" replace />;

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) return toast.error("Please enter your admin email and password");

    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
      // The server decides whether this account is an administrator.
      const token = await cred.user.getIdToken(true);
      const res = await fetch("/api/admin/verify-admin", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.authorized !== true) {
        await fbSignOut(auth).catch(() => undefined);
        throw new Error("This account does not have admin access.");
      }
      toast.success("Welcome to the Admin Dashboard.");
      nav("/admin", { replace: true });
    } catch (err: any) {
      const code = String(err?.code || "");
      if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
        toast.error("Incorrect email or password.");
      } else if (code.includes("too-many-requests")) {
        toast.error("Too many attempts. Please wait a few minutes and try again.");
      } else {
        toast.error(err?.message || "Admin sign-in failed. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) return toast.error("Please enter your admin email");
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, cleanEmail);
    } catch {
      /* The same message is shown either way so this form cannot be used to discover accounts. */
    } finally {
      setBusy(false);
    }
    toast.success("If this email belongs to an admin account, a password reset link has been sent to it.");
    setShowForgot(false);
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4 py-12 notranslate" translate="no">
      <SEO title="Admin Sign In" description="Restricted Astro With Hrishi Admin Panel." path="/admin/login" noindex />
      <div className="glass-gold rounded-3xl p-8 w-full max-w-md space-y-6 shadow-2xl border border-gold/20">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-gold/10 border border-gold/30 text-gold mb-2 shadow-inner">
            <ShieldCheck className="h-8 w-8 text-gold" />
          </div>
          <h1 className="text-2xl font-serif font-bold text-foreground">{showForgot ? "Reset Admin Password" : "Admin Portal Sign In"}</h1>
          <p className="text-xs text-muted-foreground">
            {showForgot ? "We will email a reset link to your admin address" : "Secured access for Astro With Hrishi management"}
          </p>
        </div>

        <form onSubmit={showForgot ? handleReset : handleSignIn} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-cosmic-silver/80 flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5 text-gold" /> Admin email
            </label>
            <Input
              required
              autoFocus
              type="email"
              autoComplete="username"
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 bg-background/50 border-gold/30 focus:border-gold text-foreground rounded-xl"
            />
          </div>

          {!showForgot && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-cosmic-silver/80 flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-gold" /> Password
              </label>
              <div className="relative">
                <Input
                  required
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 pr-10 bg-background/50 border-gold/30 focus:border-gold text-foreground rounded-xl"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-gold"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          <Button type="submit" disabled={busy} className="w-full h-12 bg-gradient-gold text-primary-foreground font-bold rounded-xl">
            {busy ? "Please wait…" : showForgot ? "Send reset link" : "Sign in"}
          </Button>

          <button
            type="button"
            onClick={() => setShowForgot(!showForgot)}
            className="w-full text-center text-xs text-cosmic-silver/70 hover:text-gold flex items-center justify-center gap-1.5"
          >
            {showForgot ? (
              <>
                <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
              </>
            ) : (
              "Forgot password?"
            )}
          </button>
        </form>
      </div>
    </main>
  );
};

export default AdminLogin;
