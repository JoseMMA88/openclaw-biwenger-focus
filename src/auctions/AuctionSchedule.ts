export interface AuctionWindow {
  action: 'open' | 'close';
  phase: 'preflight' | 'postcycle';
  start: Date;
  cycle: Date;
}

export function madridClock(now: Date): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return { day: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
}

export function auctionWindow(now: Date): AuctionWindow | null {
  const { day, hour, minute } = madridClock(now);
  const evening = (day === 'Thu' && hour >= 23) || (day === 'Sun' && hour >= 20);
  const morning = (day === 'Fri' || day === 'Mon') && hour < 12;
  if (!evening && !morning) return null;
  const action = day === 'Thu' || day === 'Fri' ? 'open' : 'close';
  const startHour = action === 'open' ? 23 : 20;
  // These windows never cross the Sunday DST transition (which is at 02:00/03:00).
  const midnight = now.getTime() - (hour * 60 + minute) * 60000
    - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  const start = new Date(midnight + (evening ? startHour : startHour - 24) * 3600000);
  const cycle = new Date(midnight + (evening ? 31 : 7) * 3600000);
  return { action, start, cycle, phase: now < cycle ? 'preflight' : 'postcycle' };
}

export function scheduledAction(cron: string, now: Date): 'open' | 'close' {
  const action = cron === '7 23 * * 4' ? 'open'
    : cron === '7 20 * * 0' ? 'close' : null;
  if (!action) throw new Error('Unknown auction schedule');
  const window = auctionWindow(now);
  if (!window || window.action !== action || window.phase !== 'preflight') {
    throw new Error('Scheduled auction action arrived outside its pre-cycle window; manual review required');
  }
  return action;
}
