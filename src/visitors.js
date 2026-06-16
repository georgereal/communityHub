/**
 * Phase 4.6 — Admin visitor management (Operations → Visitors)
 */
import './visitors.css';
import { refreshGate, initGate } from './visitorGate.js';

export const renderVisitors = () => refreshGate('visitor');
export const initVisitors = () => initGate('visitor');
