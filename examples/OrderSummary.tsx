// Demo component for the intl-format rule. The four lines marked ✗ should be flagged;
// the ✓ line shows the fix.

type Props = { total: number; shipping: number; placedAt: Date; locale: string };

export function OrderSummary({ total, shipping, placedAt, locale }: Props) {
  // ✗ a hand-built date: 2026/11/4 here, but 11/4/2026 in the US and 4/11/2569 in Thailand
  const placed = `${placedAt.getFullYear()}/${placedAt.getMonth() + 1}/${placedAt.getDate()}`;
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "TWD" });

  return (
    <section>
      {/* ✗ currency symbol written by hand */}
      <p>NT${total}</p>
      {/* ✗ toFixed ignores the locale's separators */}
      <p>{shipping.toFixed(2)}</p>
      {/* ✗ no locale: the server's locale during SSR */}
      <p>{placedAt.toLocaleDateString()}</p>
      {/* ✓ Intl with the user's locale */}
      <p>{money.format(total)}</p>
      <time>{placed}</time>
    </section>
  );
}
