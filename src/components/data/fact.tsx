/** One label/value row in a details card (`<dl>`); the label column width suits the card. */
export function Fact({ label, children, labelWidth = "10rem" }: { label: string; children: React.ReactNode; labelWidth?: "9.5rem" | "10rem" }) {
  return (
    <div className={`grid gap-x-2 gap-y-0.5 py-1.5 text-sm ${labelWidth === "9.5rem" ? "sm:grid-cols-[9.5rem_minmax(0,1fr)]" : "sm:grid-cols-[10rem_minmax(0,1fr)]"}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
