import React from 'react';
import {
  Bot,
  Gamepad2,
  Shield,
  Crown,
  Skull,
  Zap,
  Flame,
  Rocket,
  Sword,
  Heart,
  Smile,
  Sparkles,
} from 'lucide-react';

export const AVATAR_PRESETS = [
  { id: 'preset:gamer', label: 'Gamer', icon: Gamepad2, bg: 'bg-amber/20 text-amber border-amber/40' },
  { id: 'preset:bot', label: 'Roboter', icon: Bot, bg: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40' },
  { id: 'preset:crown', label: 'Krone', icon: Crown, bg: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40' },
  { id: 'preset:shield', label: 'Schild', icon: Shield, bg: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' },
  { id: 'preset:skull', label: 'Totenkopf', icon: Skull, bg: 'bg-purple-500/20 text-purple-400 border-purple-500/40' },
  { id: 'preset:zap', label: 'Blitz', icon: Zap, bg: 'bg-amber/20 text-amber border-amber/40' },
  { id: 'preset:flame', label: 'Flamme', icon: Flame, bg: 'bg-rose-500/20 text-rose-400 border-rose-500/40' },
  { id: 'preset:rocket', label: 'Rakete', icon: Rocket, bg: 'bg-sky-500/20 text-sky-400 border-sky-500/40' },
  { id: 'preset:sword', label: 'Schwert', icon: Sword, bg: 'bg-red-500/20 text-red-400 border-red-500/40' },
  { id: 'preset:heart', label: 'Herz', icon: Heart, bg: 'bg-pink-500/20 text-pink-400 border-pink-500/40' },
  { id: 'preset:smile', label: 'Lächeln', icon: Smile, bg: 'bg-teal-500/20 text-teal-400 border-teal-500/40' },
  { id: 'preset:sparkles', label: 'Sterne', icon: Sparkles, bg: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/40' },
] as const;

interface UserAvatarProps {
  avatar?: string | null;
  username: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

export function UserAvatar({ avatar, username, size = 'md', className = '' }: UserAvatarProps) {
  const sizeClasses = {
    xs: 'size-6 text-[10px]',
    sm: 'size-8 text-xs',
    md: 'size-10 text-sm',
    lg: 'size-14 text-lg',
    xl: 'size-20 text-2xl',
  }[size];

  const iconSizes = {
    xs: 'size-3.5',
    sm: 'size-4',
    md: 'size-5',
    lg: 'size-7',
    xl: 'size-10',
  }[size];

  // 1. Bild-URL (z. B. Steam oder Custom Image)
  if (avatar && (avatar.startsWith('http://') || avatar.startsWith('https://') || avatar.startsWith('/'))) {
    return (
      <img
        src={avatar}
        alt={username}
        className={`${sizeClasses} rounded-full object-cover border border-seam bg-rack-2 shrink-0 ${className}`}
        onError={(e) => {
          // Fallback bei Ladefehler
          e.currentTarget.style.display = 'none';
        }}
      />
    );
  }

  // 2. Preset Icon
  if (avatar && avatar.startsWith('preset:')) {
    const preset = AVATAR_PRESETS.find((p) => p.id === avatar);
    if (preset) {
      const Icon = preset.icon;
      return (
        <div
          className={`${sizeClasses} rounded-full flex items-center justify-center shrink-0 border ${preset.bg} ${className}`}
          title={username}
        >
          <Icon className={iconSizes} />
        </div>
      );
    }
  }

  // 3. Farb-Initialen
  const initials = username.slice(0, 2).toUpperCase() || 'NP';
  const colors = [
    'bg-amber/20 text-amber border-amber/40',
    'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
    'bg-cyan-500/20 text-cyan-400 border-cyan-500/40',
    'bg-purple-500/20 text-purple-400 border-purple-500/40',
    'bg-sky-500/20 text-sky-400 border-sky-500/40',
    'bg-rose-500/20 text-rose-400 border-rose-500/40',
  ];
  let charSum = 0;
  for (let i = 0; i < username.length; i++) charSum += username.charCodeAt(i);
  const colorClass = colors[charSum % colors.length];

  return (
    <div
      className={`${sizeClasses} rounded-full font-bold flex items-center justify-center shrink-0 border ${colorClass} select-none ${className}`}
      title={username}
    >
      {initials}
    </div>
  );
}
