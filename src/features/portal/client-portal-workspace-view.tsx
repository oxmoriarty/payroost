"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  LogOut,
  CreditCard,
  Calendar,
  FileText,
  DollarSign,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import { MilestoneCheckout } from "./milestone-checkout";
import type { PortalProjectData, PortalMilestone } from "./types";

interface ClientPortalWorkspaceViewProps {
  token: string;
  projectData: PortalProjectData;
  csrfToken: string;
}

export function ClientPortalWorkspaceView({
  token,
  projectData,
  csrfToken,
}: ClientPortalWorkspaceViewProps) {
  const router = useRouter();
  const [activeMilestoneId, setActiveMilestoneId] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const { milestones } = projectData;

  const paidMilestonesCount = milestones.filter((m) => m.paymentStatus === "PAID").length;
  const totalMilestonesCount = milestones.length;

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await fetch(`/api/public/portal/${encodeURIComponent(token)}/session`, {
        method: "DELETE",
      });
      router.refresh();
    } catch {
      window.location.reload();
    }
  }

  function getStatusBadge(milestone: PortalMilestone) {
    switch (milestone.paymentStatus) {
      case "PAID":
        return <Badge tone="success">Paid (Provider Verified)</Badge>;
      case "PENDING_VERIFICATION":
        return <Badge tone="warning">Pending Verification</Badge>;
      case "IN_PROGRESS":
        return <Badge tone="info">Payment In Progress</Badge>;
      default:
        if (milestone.isPayable) {
          return <Badge tone="info">Ready for Payment</Badge>;
        }
        return <Badge tone="neutral">Not Payable Yet</Badge>;
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Top Navigation Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-ink-100 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-teal-700">Client Portal</span>
            <span className="text-ink-300">•</span>
            <span className="text-xs text-ink-600">{projectData.clientEmail}</span>
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-950 sm:text-3xl">
            {projectData.title}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="success">
            <ShieldCheck className="mr-1 h-3.5 w-3.5" />
            Verified Client Session
          </Badge>
          <Button
            variant="ghost"
            className="text-xs text-ink-600 hover:text-ink-900"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            {isSigningOut ? "Signing out..." : "Sign Out"}
          </Button>
        </div>
      </div>

      {/* Project Overview Card */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
            <DollarSign className="h-4 w-4 text-teal-600" />
            <span>Total Value</span>
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-ink-950">
            {formatMoney(projectData.totalAmountMinor, projectData.currency)}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">Fixed-scope milestone contract</p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>Milestones Completed</span>
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-ink-950">
            {paidMilestonesCount} of {totalMilestonesCount}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {paidMilestonesCount === totalMilestonesCount
              ? "All milestones completed"
              : `${totalMilestonesCount - paidMilestonesCount} remaining`}
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
            <FileText className="h-4 w-4 text-teal-600" />
            <span>Agreement Status</span>
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-ink-950">
            {projectData.agreementStatus}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {projectData.agreementVersionNumber ? `Version ${projectData.agreementVersionNumber}` : "Active Version"}
          </p>
        </Card>
      </div>

      {/* Project Brief / Context */}
      {projectData.brief && (
        <Card className="mt-6 p-5 sm:p-6 bg-slate-50/50">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-600">Project Objective</h3>
          <p className="mt-2 text-sm text-ink-800 leading-relaxed">{projectData.brief}</p>
        </Card>
      )}

      {/* Milestones Section */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-ink-950">Project Milestones</h2>
            <p className="text-xs text-ink-600">
              Review deliverables and authorize milestone release payments when work is satisfied.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {milestones.length === 0 ? (
            <Card className="p-8 text-center text-ink-600">
              <p className="text-sm">No milestones have been defined for this project.</p>
            </Card>
          ) : (
            milestones.map((milestone, idx) => {
              const isSelected = activeMilestoneId === milestone.id;

              return (
                <div key={milestone.id} className="space-y-4">
                  <Card className="p-5 sm:p-6 transition-all hover:border-ink-200">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-ink-700">
                            {idx + 1}
                          </span>
                          <h3 className="font-display text-base font-bold text-ink-950 sm:text-lg">
                            {milestone.title}
                          </h3>
                          {getStatusBadge(milestone)}
                        </div>

                        {milestone.description && (
                          <p className="text-sm text-ink-700 leading-relaxed pl-8">
                            {milestone.description}
                          </p>
                        )}

                        {milestone.deliverables && milestone.deliverables.length > 0 && (
                          <div className="pl-8 pt-1">
                            <p className="text-xs font-semibold text-ink-600 uppercase tracking-wider">Deliverables:</p>
                            <ul className="mt-1 space-y-1 text-xs text-ink-800">
                              {milestone.deliverables.map((deliv, dIdx) => (
                                <li key={dIdx} className="flex items-center gap-1.5">
                                  <span className="h-1.5 w-1.5 rounded-full bg-teal-600 shrink-0" />
                                  <span>{deliv}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {milestone.dueDate && (
                          <div className="flex items-center gap-1.5 pl-8 pt-1 text-xs text-ink-500">
                            <Calendar className="h-3.5 w-3.5" />
                            <span>Target Completion: {new Date(milestone.dueDate).toLocaleDateString()}</span>
                          </div>
                        )}
                      </div>

                      {/* Right Column: Amount & Pay Action */}
                      <div className="flex flex-row items-center justify-between sm:flex-col sm:items-end gap-3 pt-3 sm:pt-0 border-t sm:border-t-0 border-ink-100">
                        <span className="font-display text-xl font-bold text-ink-950 sm:text-2xl">
                          {formatMoney(milestone.amountMinor, milestone.currency)}
                        </span>

                        {milestone.paymentStatus === "PAID" ? (
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-4 w-4" />
                            <span>Paid</span>
                          </div>
                        ) : milestone.paymentStatus === "PENDING_VERIFICATION" ? (
                          <Button
                            variant="secondary"
                            className="text-xs"
                            onClick={() => setActiveMilestoneId(isSelected ? null : milestone.id)}
                          >
                            <AlertTriangle className="mr-1.5 h-3.5 w-3.5 text-amber-600" />
                            Pending Verification
                          </Button>
                        ) : milestone.isPayable ? (
                          <Button
                            onClick={() => setActiveMilestoneId(isSelected ? null : milestone.id)}
                            className="text-xs sm:text-sm"
                          >
                            <CreditCard className="mr-1.5 h-4 w-4" />
                            {isSelected ? "Hide Checkout" : "Pay Milestone"}
                          </Button>
                        ) : (
                          <span className="text-xs text-ink-400 font-medium">
                            Not Payable
                          </span>
                        )}
                      </div>
                    </div>
                  </Card>

                  {/* Render Checkout Component when selected */}
                  {isSelected && (
                    <div className="pl-0 sm:pl-8">
                      <MilestoneCheckout
                        token={token}
                        milestone={milestone}
                        csrfToken={csrfToken}
                        onCancel={() => setActiveMilestoneId(null)}
                        onPaymentSuccess={() => {
                          router.refresh();
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
