"use client";

import clsx from "clsx";
import { ReactNode, MouseEventHandler } from "react";

export type ButtonVariant = "primary" | "secondary" | "tertiary";

export interface ButtonProps {
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

export default function Button({
  variant = "primary",
  className,
  children,
  disabled = false,
  onClick,
}: ButtonProps) {
  const baseClasses = "px-4 py-2 rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary";
  let bgColor = "bg-primary";
  let textColor = "text-white";

  switch (variant) {
    case "secondary":
      bgColor = "bg-gray-600";
      textColor = "text-white";
      break;
    case "tertiary":
      bgColor = "bg-gray-400";
      textColor = "text-gray-900";
      break;
    default:
      bgColor = "bg-primary";
      textColor = "text-white";
  }

  return (
    <button
      className={clsx(
        "rounded-md focus:outline-none focus:ring-2 focus:ring-primary",
        disabled && "opacity-50 cursor-not-allowed",
        className,
        {
          [bgColor]: bgColor,
          "text-white": textColor,
          "text-gray-900": variant === "tertiary",
        },
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}