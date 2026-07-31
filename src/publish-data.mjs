import fs from 'node:fs/promises';

const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const latest = JSON.parse(await fs.readFile('data/latest.json', 'utf8'));
const include = config.notificationFacilities?.include ?? [];
const exclude = config.notificationFacilities?.exclude ?? [];
const tickets = config.ticketInventory ?? {};

const matchAny = (name, patterns) => patterns.some(pattern => name.includes(pattern));
const enabled = name => (include.length === 0 || matchAny(name, include)) && !matchAny(name, exclude);
const dateInRange = (date, start, end) => date >= start && date <= end;

function ticketInfo(facility, date) {
  const commonSummer = dateInRange(date, '2026-07-18', '2026-08-31') && !facility.includes('箱根翡翠') && !facility.includes('有馬六彩') && !facility.includes('京都鷹峯');
  const hakoneSummer = (facility.includes('箱根翡翠') || facility.includes('有馬六彩')) && dateInRange(date, '2026-08-01', '2026-08-16');
  const specificPeriod = commonSummer || hakoneSummer;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const saturday = day === 6;
  const usableTickets = (!specificPeriod && !saturday && (tickets.homeTickets ?? 0) > 0)
    ? [`${tickets.homeFacility}ホーム券`, '相互利用券']
    : ['相互利用券'];
  return {
    usableTickets,
    notes: specificPeriod ? '夏季特定期間' : saturday ? '土曜日' : '通常日'
  };
}

const slots = [];
for (const facility of latest.facilities ?? []) {
  if (!enabled(facility.name)) continue;
  for (const room of facility.mutual?.rooms ?? []) {
    for (const slot of room.availability ?? []) {
      const status = slot.effectiveStatus ?? slot.status;
      if (!['available', 'few'].includes(status)) continue;
      const info = ticketInfo(facility.name, slot.date);
      if (!info.usableTickets.includes('相互利用券') || (tickets.mutualTickets ?? 0) < 1) continue;
      slots.push({
        facility: facility.name,
        date: slot.date,
        status: status === 'few' ? 'few' : 'available',
        room: room.name,
        pet: room.pet,
        standardCapacity: room.standardCapacity,
        maxCapacity: room.maxCapacity,
        areaSqm: room.areaSqm,
        mutualPriceYen: room.mutualPriceYen,
        usableTickets: info.usableTickets,
        notes: info.notes
      });
    }
  }
}

slots.sort((a, b) => a.date.localeCompare(b.date) || a.facility.localeCompare(b.facility, 'ja') || a.room.localeCompare(b.room, 'ja'));
const updatedAt = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo'
}).format(new Date(latest.fetchedAt));

await fs.writeFile('data.json', JSON.stringify({
  updatedAt,
  homeFacility: `${tickets.homeFacility}ホーム券`,
  homeTickets: tickets.homeTickets ?? 0,
  mutualTickets: tickets.mutualTickets ?? 0,
  slots
}, null, 2) + '\n');
console.log(`Published ${slots.length} slot(s).`);
