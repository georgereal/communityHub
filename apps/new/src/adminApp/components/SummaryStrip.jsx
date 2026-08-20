import React from 'react';

export default function SummaryStrip({ cards = [], activeKey, onSelect }) {
    if (!cards.length) return null;
    return (
        <section className="resident-summary" aria-label="Summary">
            {cards.map((c) => {
                const active = activeKey == null ? c.key === cards[0]?.key : activeKey === c.key;
                return (
                    <button
                        key={c.key}
                        type="button"
                        className={`resident-summary-card resident-summary-card--${c.tone || 'default'}${active ? ' resident-summary-card--active' : ''}`}
                        title={c.hint || c.label}
                        onClick={() => onSelect?.(c.key === activeKey ? '' : c.key)}
                    >
                        <span className="resident-summary-card__label">{c.label}</span>
                        <strong className="resident-summary-card__value">{c.value}</strong>
                        {c.sub ? <span className="resident-summary-card__sub">{c.sub}</span> : null}
                    </button>
                );
            })}
        </section>
    );
}
