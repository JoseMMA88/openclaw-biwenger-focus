import type { AuctionSnapshot } from '../domain/focus.js';
import type { DailyMarketSnapshot, MarketDailySummary } from '../domain/market.js';
import { Logger } from '../logger.js';
import type { Notifier } from '../notify/Notifier.js';
import { nowSec } from '../utils/time.js';
import { MarketRepository } from '../db/MarketRepository.js';

export class MarketReportService {
  private readonly repo: MarketRepository;
  private readonly notifier: Notifier;
  private readonly logger: Logger;
  private readonly tz: string;
  private readonly scheduleHour: number;
  private readonly scheduleMinute: number;
  private readonly topLimit: number;

  constructor(options: {
    repo: MarketRepository;
    notifier: Notifier;
    logger: Logger;
    tz: string;
    scheduleHour: number;
    scheduleMinute: number;
    topLimit: number;
  }) {
    this.repo = options.repo;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.tz = options.tz;
    this.scheduleHour = options.scheduleHour;
    this.scheduleMinute = options.scheduleMinute;
    this.topLimit = options.topLimit;
  }

  observeMarket(input: { auctions: AuctionSnapshot[]; daily: DailyMarketSnapshot[] }, atSec = nowSec()): void {
    this.repo.upsertAuctions(input.auctions, atSec);
    this.repo.upsertDailyMarket(input.daily, atSec);
  }

  isDailyReportDue(atSec = nowSec()): boolean {
    const current = this.getClock(atSec);
    const scheduledMinuteOfDay = this.scheduleHour * 60 + this.scheduleMinute;
    const currentMinuteOfDay = current.hour * 60 + current.minute;

    if (currentMinuteOfDay < scheduledMinuteOfDay) {
      return false;
    }

    return !this.repo.hasReportForDate(current.dateKey);
  }

  async emitDailyReport(
    input: { auctions: AuctionSnapshot[]; daily: DailyMarketSnapshot[] },
    atSec = nowSec(),
    options: { force?: boolean } = {}
  ): Promise<MarketDailySummary | null> {
    const clock = this.getClock(atSec);
    const force = options.force === true;
    if (!force && this.repo.hasReportForDate(clock.dateKey)) {
      return null;
    }

    const summary = this.buildSummary(input, atSec, clock.dateKey);
    const text = this.renderSummary(summary);

    this.repo.recordReport(
      clock.dateKey,
      JSON.stringify(summary),
      input.auctions.map((entry) => entry.playerId),
      input.daily.map((entry) => entry.playerId),
      atSec
    );

    await this.notifier.notify({
      focusId: `market-${clock.dateKey}`,
      eventType: 'market_daily_report',
      text,
      payload: {
        report_date: summary.reportDate,
        daily_active_count: summary.daily.activeCount,
        daily_recommended_count: summary.daily.recommended.length,
        auctions_active_count: summary.auctions.activeCount,
        auctions_risers_count: summary.auctions.topRisers.length
      }
    });

    this.logger.info('Market daily report emitted', {
      action: 'market_daily_report_emitted',
      report_date: summary.reportDate,
      daily_active_count: summary.daily.activeCount,
      daily_recommended_count: summary.daily.recommended.length,
      auctions_active_count: summary.auctions.activeCount,
      auctions_risers_count: summary.auctions.topRisers.length
    });

    return summary;
  }

  getStatus(atSec = nowSec()): {
    nowDate: string;
    scheduleHour: number;
    scheduleMinute: number;
    dueNow: boolean;
    lastReportDate: string | null;
    lastReportAt: number | null;
  } {
    const clock = this.getClock(atSec);
    const last = this.repo.getLastReport();

    return {
      nowDate: clock.dateKey,
      scheduleHour: this.scheduleHour,
      scheduleMinute: this.scheduleMinute,
      dueNow: this.isDailyReportDue(atSec),
      lastReportDate: last?.reportDate ?? null,
      lastReportAt: last?.createdAt ?? null
    };
  }

  private buildSummary(
    input: { auctions: AuctionSnapshot[]; daily: DailyMarketSnapshot[] },
    atSec: number,
    reportDate: string
  ): MarketDailySummary {
    const auctions = input.auctions;
    const daily = input.daily;

    const auctionById = new Map<number, AuctionSnapshot>();
    for (const auction of auctions) {
      auctionById.set(auction.playerId, auction);
    }

    const dailyById = new Map<number, DailyMarketSnapshot>();
    for (const player of daily) {
      dailyById.set(player.playerId, player);
    }

    const auctionIds = auctions.map((entry) => entry.playerId);
    const dailyIds = daily.map((entry) => entry.playerId);

    const auctionSnapshots = this.repo.getPlayersByIds(auctionIds);
    const dailySnapshots = this.repo.getDailyPlayersByIds(dailyIds);

    const recentAuctionSnapshots = this.repo.listPlayersSeenSince(atSec - 172800);
    const recentDailySnapshots = this.repo.listDailyPlayersSeenSince(atSec - 172800);

    const auctionNewToday = recentAuctionSnapshots
      .filter((player) => this.getDateKeyFromEpoch(player.firstSeenAt) === reportDate)
      .sort((a, b) => b.firstSeenAt - a.firstSeenAt);

    const dailyNewToday = recentDailySnapshots
      .filter((player) => this.getDateKeyFromEpoch(player.firstSeenAt) === reportDate)
      .sort((a, b) => b.firstSeenAt - a.firstSeenAt);

    const auctionTopRisers = auctionSnapshots
      .map((player) => {
        const fromPrice = player.firstSeenPrice;
        const toPrice = player.lastSeenPrice;
        if (fromPrice === null || toPrice === null) return null;
        const rise = toPrice - fromPrice;
        if (rise <= 0) return null;
        return {
          playerId: player.playerId,
          playerName: player.playerName,
          fromPrice,
          toPrice,
          rise
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.rise - a.rise)
      .slice(0, this.topLimit);

    const dailyTopRisers = dailySnapshots
      .map((player) => {
        const fromPrice = player.prevSeenPrice ?? player.firstSeenPrice;
        const toPrice = player.lastSeenPrice;
        if (fromPrice === null || toPrice === null) return null;
        const rise = toPrice - fromPrice;
        if (rise <= 0) return null;
        const risePct = fromPrice > 0 ? (rise / fromPrice) * 100 : 0;
        const lastDelta = player.prevSeenPrice !== null ? toPrice - player.prevSeenPrice : null;

        return {
          playerId: player.playerId,
          playerName: player.playerName,
          fromPrice,
          toPrice,
          rise,
          risePct,
          lastDelta
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.risePct - a.risePct)
      .slice(0, this.topLimit);

    const recommended = dailyTopRisers
      .map((entry) => {
        const price = entry.toPrice;
        const riseToday = entry.rise;
        const riseTodayPct = entry.risePct;
        const riseLastTick = entry.lastDelta;
        const riseLastTickPct = riseLastTick !== null && entry.fromPrice > 0
          ? (riseLastTick / entry.fromPrice) * 100
          : null;

        const scoreRaw = (riseTodayPct * 0.7) + ((riseLastTickPct ?? 0) * 0.3);
        const score = Math.round(Math.max(0, Math.min(100, scoreRaw * 10)));

        return {
          playerId: entry.playerId,
          playerName: entry.playerName,
          price,
          riseToday,
          riseTodayPct,
          riseLastTick,
          riseLastTickPct,
          score,
          reason: `Subida detectada ${riseToday.toLocaleString('es-ES')} (${riseTodayPct.toFixed(1)}%)`
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return {
      reportDate,
      nowSec: atSec,
      auctions: {
        activeCount: auctions.length,
        newTodayCount: auctionNewToday.length,
        newTodayTop: auctionNewToday.slice(0, this.topLimit).map((entry) => {
          const active = auctionById.get(entry.playerId);
          const currentPrice = active?.currentPrice ?? entry.lastSeenPrice;
          const delta = entry.firstSeenPrice !== null && currentPrice !== null
            ? currentPrice - entry.firstSeenPrice
            : null;
          return {
            playerId: entry.playerId,
            playerName: entry.playerName,
            firstSeenPrice: entry.firstSeenPrice,
            price: currentPrice,
            deltaFromFirstSeen: delta,
            until: active?.until ?? entry.lastUntil
          };
        }),
        topRisers: auctionTopRisers,
        endedSinceLastReport: this.repo
          .listEndedSinceLastReport(auctionIds, this.topLimit)
          .filter((entry) => entry.lastSeenAt >= atSec - 21600)
          .map((entry) => ({
            playerId: entry.playerId,
            playerName: entry.playerName,
            lastSeenPrice: entry.lastSeenPrice,
            lastSeenAt: entry.lastSeenAt
          }))
      },
      daily: {
        activeCount: daily.length,
        newTodayCount: dailyNewToday.length,
        newTodayTop: dailyNewToday.slice(0, this.topLimit).map((entry) => {
          const active = dailyById.get(entry.playerId);
          const currentPrice = active?.currentPrice ?? entry.lastSeenPrice;
          const delta = entry.firstSeenPrice !== null && currentPrice !== null
            ? currentPrice - entry.firstSeenPrice
            : null;

          return {
            playerId: entry.playerId,
            playerName: entry.playerName,
            firstSeenPrice: entry.firstSeenPrice,
            price: currentPrice,
            deltaFromFirstSeen: delta
          };
        }),
        topRisers: dailyTopRisers,
        recommended
      }
    };
  }

  private renderSummary(summary: MarketDailySummary): string {
    const lines: string[] = [];
    lines.push(`📊 Informe diario mercado (${summary.reportDate})`);

    lines.push('');
    lines.push(`🛒 Mercado diario: ${summary.daily.activeCount} activos | ${summary.daily.newTodayCount} nuevos hoy`);

    if (summary.daily.newTodayTop.length > 0) {
      lines.push('🆕 Nuevos mercado diario:');
      for (const entry of summary.daily.newTodayTop.slice(0, 5)) {
        const price = entry.price === null ? 'N/D' : entry.price.toLocaleString('es-ES');
        const delta = entry.deltaFromFirstSeen;
        const deltaText = delta === null
          ? ''
          : delta > 0
            ? `, Δ +${delta.toLocaleString('es-ES')}`
            : delta < 0
              ? `, Δ -${Math.abs(delta).toLocaleString('es-ES')}`
              : ', Δ 0';
        lines.push(`- ${entry.playerName} (${price}${deltaText})`);
      }
    }

    if (summary.daily.topRisers.length > 0) {
      lines.push('📈 Más calientes (mercado diario):');
      for (const entry of summary.daily.topRisers.slice(0, 5)) {
        const lastTickText = entry.lastDelta === null
          ? ''
          : entry.lastDelta > 0
            ? ` | última +${entry.lastDelta.toLocaleString('es-ES')}`
            : entry.lastDelta < 0
              ? ` | última -${Math.abs(entry.lastDelta).toLocaleString('es-ES')}`
              : ' | última 0';
        lines.push(
          `- ${entry.playerName}: +${entry.rise.toLocaleString('es-ES')} (${entry.risePct.toFixed(1)}%)${lastTickText}`
        );
      }
    }

    if (summary.daily.recommended.length > 0) {
      lines.push('🤖 Recomendados (criterio: subida % hoy + momento última lectura):');
      for (const entry of summary.daily.recommended) {
        lines.push(
          `- ${entry.playerName} | score ${entry.score}/100 | ${entry.price.toLocaleString('es-ES')} | ${entry.reason}`
        );
      }
    }

    lines.push('');
    lines.push(`🎯 Subastas/Pujas: ${summary.auctions.activeCount} activas | ${summary.auctions.newTodayCount} nuevas hoy`);

    if (summary.auctions.topRisers.length > 0) {
      lines.push('💸 Top subidas en pujas:');
      for (const entry of summary.auctions.topRisers.slice(0, 5)) {
        lines.push(
          `- ${entry.playerName}: +${entry.rise.toLocaleString('es-ES')} (${entry.fromPrice.toLocaleString('es-ES')} → ${entry.toPrice.toLocaleString('es-ES')})`
        );
      }
    }

    if (summary.auctions.endedSinceLastReport.length > 0) {
      lines.push('🏁 Salieron de subasta desde el último informe:');
      for (const entry of summary.auctions.endedSinceLastReport.slice(0, 5)) {
        const price = entry.lastSeenPrice === null ? 'N/D' : entry.lastSeenPrice.toLocaleString('es-ES');
        lines.push(`- ${entry.playerName} (último precio: ${price})`);
      }
    }

    return lines.join('\n');
  }

  private getClock(atSec: number): { dateKey: string; hour: number; minute: number } {
    const date = new Date(atSec * 1000);
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

    return {
      dateKey: `${year}-${month}-${day}`,
      hour,
      minute
    };
  }

  private getDateKeyFromEpoch(atSec: number): string {
    return this.getClock(atSec).dateKey;
  }
}
