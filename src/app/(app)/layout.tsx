import { cookies } from "next/headers";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { AppTour } from "@/components/app-shell/app-tour";
import { KeyboardShortcuts } from "@/components/app-shell/keyboard-shortcuts";
import { SessionGuard } from "@/components/app-shell/session-guard";
import { ShellProvider } from "@/components/app-shell/shell-context";
import { SkipToList } from "@/components/app-shell/skip-to-list";
import { StepUpProvider } from "@/components/step-up/step-up-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { can } from "@/lib/permissions";
import { requireViewer } from "@/server/authz/viewer";
import { reviewCount } from "@/server/ledger/queries";
import { notificationsFor } from "@/server/notifications";
import { NavigationProgress } from "@/components/app-shell/navigation-progress";
import { Suspense } from "react";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const viewer = await requireViewer();
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  const review = can(viewer.role, "finance.view") ? await reviewCount() : 0;

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:ring-3 focus:ring-ring"
      >
        Skip to content
      </a>
      <Suspense fallback={null}>
        <SkipToList />
      </Suspense>
      <AppSidebar viewer={viewer} badges={{ review }} />
      <SidebarInset className="min-w-0">
        <ShellProvider role={viewer.role} staffId={viewer.staffId} notifications={notificationsFor(viewer)}>
          <StepUpProvider>{children}</StepUpProvider>
          <KeyboardShortcuts />
          <AppTour role={viewer.role} firstName={viewer.characterName.split(" ")[0]} completedAt={viewer.tourCompletedAt} touredAs={viewer.tourRole} />
        </ShellProvider>
      </SidebarInset>
      <SessionGuard />
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
    </SidebarProvider>
  );
}
