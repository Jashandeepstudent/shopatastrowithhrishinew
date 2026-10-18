import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { fetchPaymentSettings, testRazorpayConnection, type PaymentGatewayAdminSettings } from "@/lib/adminApi";

/**
 * Read-only view of the payment gateway. Razorpay keys live in the Netlify environment
 * variables and are never shown, edited or stored from the admin panel.
 */
export const PaymentSettingsTab = () => {
  const [settings, setSettings] = useState<PaymentGatewayAdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetchPaymentSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  const runTest = async () => {
    setTesting(true);
    const res = await testRazorpayConnection();
    setTesting(false);
    if (res.valid) toast.success(`${res.message || "Razorpay keys are working."} (${res.mode})`);
    else toast.error(res.error || "Razorpay rejected the configured keys");
  };

  if (loading) return <p className="text-sm text-cosmic-silver/70">Loading payment settings…</p>;
  if (!settings) return <p className="text-sm text-red-400">Could not load payment settings. Please sign in again.</p>;

  const Row = ({ label, ok, value }: { label: string; ok?: boolean; value: string }) => (
    <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-background/50 border border-gold/20 text-sm">
      <span className="text-cosmic-silver">{label}</span>
      <span className={`flex items-center gap-1.5 font-semibold ${ok === false ? "text-red-400" : "text-emerald-400"}`}>
        {ok === false ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} {value}
      </span>
    </div>
  );

  return (
    <div className="glass-gold rounded-3xl border border-gold/30 p-6 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-gold" />
        <h3 className="font-semibold text-foreground">Payment gateway (Razorpay)</h3>
      </div>
      <Row label="Mode" ok value={settings.is_live ? "Live (real money)" : "Test mode"} />
      <Row label="Key ID" ok={Boolean(settings.razorpay_key_id)} value={settings.razorpay_key_id || "Not set"} />
      <Row label="Key secret" ok={Boolean(settings.has_key_secret)} value={settings.has_key_secret ? "Configured" : "Missing"} />
      <Row label="Webhook secret" ok={Boolean(settings.has_webhook_secret)} value={settings.has_webhook_secret ? "Configured" : "Missing"} />
      <Row label="Webhook URL" ok value="/api/payments/webhook" />
      <p className="text-xs text-cosmic-silver/60">
        Keys and secrets are managed in the Netlify environment variables (Site settings, Environment variables), not here.
      </p>
      <Button onClick={() => void runTest()} disabled={testing} className="bg-gradient-gold text-primary-foreground rounded-xl">
        {testing ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />} Test Razorpay connection
      </Button>
    </div>
  );
};

export default PaymentSettingsTab;
