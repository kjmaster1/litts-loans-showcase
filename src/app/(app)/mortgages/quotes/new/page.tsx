import type { Metadata } from "next";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { QuoteFormPage } from "../quote-page";

export const metadata: Metadata = { title: "New mortgage quote" };

export default async function NewQuotePage({ searchParams }: PageProps<"/mortgages/quotes/new">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const sp = await searchParams;
  return <QuoteFormPage viewer={viewer} id={null} stateId={typeof sp.stateId === "string" ? sp.stateId : undefined} />;
}
