"use client";

import {
  LayoutDashboard,
  Package,
  Receipt,
  Wallet,
  Settings,
} from "lucide-react";

type Props = {
  active: string;
  setActive: (value: string) => void;
};

export default function BottomNav({
  active,
  setActive,
}: Props) {
  const items = [
    {
      id: "dashboard",
      label: "ראשי",
      icon: LayoutDashboard,
    },
    {
      id: "shipments",
      label: "שיווקים",
      icon: Package,
    },
    {
      id: "settlements",
      label: "התחשבנויות",
      icon: Receipt,
    },
    {
      id: "payments",
      label: "תקבולים",
      icon: Wallet,
    },
    {
      id: "settings",
      label: "הגדרות",
      icon: Settings,
    },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-zinc-200">
      <div className="max-w-md mx-auto flex justify-around py-2">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.id}
              onClick={() =>
                setActive(item.id)
              }
              className={`flex flex-col items-center text-xs ${
                active === item.id
                  ? "text-black"
                  : "text-zinc-400"
              }`}
            >
              <Icon size={20} />
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}