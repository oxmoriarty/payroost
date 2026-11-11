export interface PortalMilestone {
  id: string;
  title: string;
  description: string;
  deliverables: string[];
  amountMinor: number;
  currency: string;
  dueDate: string | null;
  sortOrder: number;
  status: string;
  isPayable: boolean;
  paymentStatus: "PAID" | "PENDING_VERIFICATION" | "IN_PROGRESS" | "UNPAID";
  paymentIntentId?: string | null;
  providerOrderId?: string | null;
  completedCaptureId?: string | null;
}

export interface PortalProjectData {
  id: string;
  title: string;
  clientName: string;
  clientEmail: string;
  brief: string;
  currency: string;
  totalAmountMinor: number;
  projectStatus: string;
  agreementStatus: string;
  agreementVersionNumber?: number;
  milestones: PortalMilestone[];
}

export interface PortalInvitationMetadata {
  valid: boolean;
  projectTitle: string;
  expiresAt: string;
}
