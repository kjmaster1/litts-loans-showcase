"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Rich colours from the app's tokens: Sonner's own green on green is 4.25:1 (fails AA).
          "--success-bg": "var(--success-subtle)",
          "--success-text": "var(--success)",
          "--success-border": "color-mix(in oklab, var(--success) 30%, transparent)",
          "--error-bg": "var(--danger-subtle)",
          "--error-text": "var(--danger)",
          "--error-border": "color-mix(in oklab, var(--danger) 30%, transparent)",
          "--warning-bg": "var(--warning-subtle)",
          "--warning-text": "var(--warning)",
          "--warning-border": "color-mix(in oklab, var(--warning) 30%, transparent)",
          "--info-bg": "var(--info-subtle)",
          "--info-text": "var(--info)",
          "--info-border": "color-mix(in oklab, var(--info) 30%, transparent)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
