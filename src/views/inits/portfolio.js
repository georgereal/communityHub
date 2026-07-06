import { initPortfolio } from '../../portfolio.js';

let wired = false;

export default async function initPortfolioView() {
    if (wired) return;
    wired = true;
    initPortfolio();
}
