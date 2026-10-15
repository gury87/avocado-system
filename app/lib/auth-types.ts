export type Role = "admin" | "worker" | "viewer";
export type Profile = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
};
export const roleLabels: Record<Role, string> = {
  admin: "מנהל",
  worker: "עובד",
  viewer: "צופה",
};
