import React, { useEffect, useState } from 'react';

export default function InviteCard({ invite, onJoin, joined }) {
  const [details, setDetails] = useState(invite || null);
  useEffect(() => {
    if (!invite?.code || invite.name) return;
    let alive = true;
    fetch(`/api/invites/${encodeURIComponent(invite.code)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (alive && d?.invite) setDetails(d.invite); })
      .catch(() => {});
    return () => { alive = false; };
  }, [invite?.code, invite?.name]);
  if (!details) return null;
  return (
    <span className="invite-card" role="article">
      <span className="invite-card-image" style={details.image ? { backgroundImage:`url(${details.image})` } : undefined}>
        {!details.image && <span>🌐</span>}
      </span>
      <span className="invite-card-body">
        <span className="invite-card-kicker">SERVER INVITE</span>
        <strong>{details.title || `Join ${details.name}`}</strong>
        <span className="invite-card-name">{details.name}</span>
        {details.description && <span className="invite-card-description">{details.description}</span>}
        <button type="button" className="invite-join-btn" onClick={() => onJoin?.(details.code)} disabled={joined}>
          {joined ? '✓ Joined' : 'Join server'}
        </button>
      </span>
    </span>
  );
}
