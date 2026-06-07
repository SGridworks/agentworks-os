'use client';

export default function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-sm font-medium ${className || 'text-primary'}`}>
      {children}
    </span>
  );
}
