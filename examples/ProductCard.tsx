// Demo component for trying l10n-review end to end.
// It intentionally mixes hardcoded strings (which the bot should flag)
// with properly localized ones (which it should leave alone).

type Product = { id: string; name: string; image: string; price: number };

type Props = {
  product: Product;
  soldOut: boolean;
  t: (key: string, values?: Record<string, unknown>) => string;
  onAdd: (id: string) => void;
};

export function ProductCard({ product, soldOut, t, onAdd }: Props) {
  return (
    <article className="product-card">
      <img src={product.image} alt="商品圖片" />
      <h3>{product.name}</h3>
      <p>{t("product.price", { price: product.price })}</p>
      <span className="badge">{soldOut ? "已售完" : t("product.inStock")}</span>
      <button type="button" disabled={soldOut} onClick={() => onAdd(product.id)}>
        加入購物車
      </button>
    </article>
  );
}
