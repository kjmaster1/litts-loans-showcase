import type { Metadata } from "next";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { QuoteFormPage } from "../../quote-page";

export const metadata: Metadata = { title: "Edit mortgage quote" };

export default async function EditQuotePage({ params }: PageProps<"/mortgages/quotes/[id]/edit">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const { id } = await params;
  return <QuoteFormPage viewer={viewer} id={id} />;
}
