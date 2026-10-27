
import { Tag, Sparkles } from "lucide-react";
import { useOffers } from "@/hooks/useOffers";

/**
 * Promo banner strip for active entries in the "offers" collection (managed from
 * Admin → Offers / Promotions). Renders nothing while loading or when there are
 * no live offers, so pages that mount it never show an empty placeholder.
 */
const OffersBanner = () => {
  const { offers, loading } = useOffers();

  if (loading || offers.length === 0) return null;

  return (
    <section className="container mb-10">
      <div className={offers.length > 1 ? "flex gap-4 overflow-x-auto pb-1 snap-x snap-mandatory" : ""}>
        {offers.map((o) => (
          <div
            key={o.id}
            className={
              offers.length > 1
                ? "relative shrink-0 w-[85vw] sm:w-[420px] snap-start rounded-2xl overflow-hidden glass-gold border border-gold/30"
                : "relative rounded-2xl overflow-hidden glass-gold border border-gold/30"
            }
          >
            {o.image_url && (
              <div className="relative h-32 sm:h-36 w-full">
                <img src={o.image_url} alt={o.title} className="w-full h-full object-cover" loading="lazy" />
                <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/30 to-transparent" />
              </div>
            )}
            <div className={`p-4 sm:p-5 ${o.image_url ? "-mt-10 relative" : ""}`}>
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] font-semibold px-2.5 py-1 rounded-full bg-gradient-gold text-primary-foreground">
                  <Sparkles className="h-3 w-3" /> Offer
                </span>
                {o.discount_text && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-gold/15 text-gold border border-gold/30">
                    <Tag className="h-3 w-3" /> {o.discount_text}
                  </span>
                )}
              </div>
              <h3 className="font-display text-lg sm:text-xl text-foreground font-bold">{o.title}</h3>
              {o.description && (
                <p className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed">{o.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default OffersBanner;
