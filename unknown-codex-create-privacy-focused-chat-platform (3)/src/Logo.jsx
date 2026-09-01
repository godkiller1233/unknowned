import React from 'react';

/**
 * Lightweight text/emoji logo. Renders as an inline styled glyph (no image
 * network request), so it loads instantly and adapts to light/dark via CSS var.
 */
export function Logo({ size = 48, animate = false }) {
  return (
    <span
      className={`brand-logo-text${animate ? ' logo-animate' : ''}`}
      style={{ '--logosz': `${size}px`, fontSize: `${size * 0.5}px`, width: size, height: size, lineHeight: `${size}px` }}
      role="img"
      aria-label="Unknown logo"
    >
      <span className="brand-glyph">?</span>
    </span>
  );
}

/** Legacy SVG logo, kept for anyone who specifically requested the drawn mark. */
export function LegacyLogo({ size = 48, animate = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={animate ? 'logo-animate' : ''}
      aria-label="Unknown logo"
    >
      <path
        d="M8 6 C8 3 10 2 13 2 L51 2 C54 2 56 3 56 6 L56 40 C56 43 54 44 51 44 L36 44 L28 56 L24 44 L13 44 C10 44 8 43 8 40 Z"
        fill="#5865f2"
        opacity="0.15"
      />
      <path
        d="M8 6 C8 3 10 2 13 2 L51 2 C54 2 56 3 56 6 L56 40 C56 43 54 44 51 44 L36 44 L28 56 L24 44 L13 44 C10 44 8 43 8 40 Z"
        fill="none"
        stroke="#f23f42"
        strokeWidth="1.5"
        opacity="0.4"
        transform="translate(2, -1)"
      />
      <path
        d="M8 6 C8 3 10 2 13 2 L51 2 C54 2 56 3 56 6 L56 40 C56 43 54 44 51 44 L36 44 L28 56 L24 44 L13 44 C10 44 8 43 8 40 Z"
        fill="none"
        stroke="#5865f2"
        strokeWidth="2.5"
      />
      <text x="32" y="34" textAnchor="middle" fontSize="28" fontWeight="900" fill="#5865f2" fontFamily="Arial, sans-serif">?</text>
      <text x="34" y="33" textAnchor="middle" fontSize="28" fontWeight="900" fill="#f23f42" fontFamily="Arial, sans-serif" opacity="0.3">?</text>
    </svg>
  );
}

export function Mascot({ size = 80, mood = 'happy' }) {
  const eyes = mood === 'happy' ? (
    <>
      <circle cx="22" cy="28" r="4" fill="#5865f2" />
      <circle cx="42" cy="28" r="4" fill="#5865f2" />
      <circle cx="23" cy="27" r="1.5" fill="white" />
      <circle cx="43" cy="27" r="1.5" fill="white" />
    </>
  ) : mood === 'thinking' ? (
    <>
      <path d="M18 28 Q22 24 26 28" stroke="#5865f2" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M38 28 Q42 24 46 28" stroke="#5865f2" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </>
  ) : (
    <>
      <circle cx="22" cy="28" r="4" fill="#5865f2" />
      <circle cx="42" cy="28" r="4" fill="#5865f2" />
    </>
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="mascot"
      aria-label="Unknown mascot"
    >
      <ellipse cx="32" cy="32" rx="26" ry="26" fill="#2b2d31" stroke="#5865f2" strokeWidth="2.5" />
      {eyes}
      <text x="32" y="52" textAnchor="middle" fontSize="16" fontWeight="900" fill="#5865f2" fontFamily="Arial, sans-serif">?</text>
      <ellipse cx="22" cy="62" rx="7" ry="5" fill="#2b2d31" stroke="#5865f2" strokeWidth="2" />
      <ellipse cx="42" cy="62" rx="7" ry="5" fill="#2b2d31" stroke="#5865f2" strokeWidth="2" />
    </svg>
  );
}