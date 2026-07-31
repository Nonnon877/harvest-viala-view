import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  locale: 'ja-JP',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
});
page.setDefaultNavigationTimeout(config.navigationTimeoutMs ?? 60000);

const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
const norm = value => clean(value).normalize('NFKC');
const textOf = cell => clean(typeof cell === 'string' ? cell : cell?.text);

function parseStatus(raw) {
  const value = clean(raw);
  if (value.includes('〇') || value === '○' || value.includes('空室')) return 'available';
  if (value.includes('△') || value.includes('残りわずか')) return 'few';
  if (value.includes('↑') || value.includes('←')) return 'follow_home';
  if (value.includes('×') || value.includes('満室')) return 'full';
  if (value.includes('キャンセル待ち') || value.includes('⊝')) return 'waitlist';
  if (value.includes('TEL')) return 'phone';
  if (value.includes('※') || value.includes('特定期間')) return 'special_period';
  return 'unknown';
}

function parseRoom(text) {
  const value = clean(text);
  const standard = value.match(/標準\s*(\d+)名/);
  const maximum = value.match(/最大\s*(\d+)名/);
  const mutualPrice = value.match(/相互利用[：:]\s*([\d,]+)円/);
  const area = value.match(/(\d+(?:\.\d+)?)㎡/);
  const name = value.replace(/標準\s*\d+名[\s\S]*$/, '').replace(/\s*\[\d+(?:-\d+)?\]\s*$/, '').trim();
  return {
    name,
    pet: /ペット|犬同伴|愛犬/.test(name),
    standardCapacity: standard ? Number(standard[1]) : null,
    maxCapacity: maximum ? Number(maximum[1]) : null,
    mutualPriceYen: mutualPrice ? Number(mutualPrice[1].replaceAll(',', '')) : null,
    areaSqm: area ? Number(area[1]) : null
  };
}

function buildDates(monthLabel, headers) {
  const m = clean(monthLabel).match(/(\d{4})年(\d{1,2})月/);
  if (!m) return headers.map(() => null);
  let year = Number(m[1]);
  let month = Number(m[2]);
  let previous = null;
  return headers.map(header => {
    const d = textOf(header).match(/(\d{1,2})$/);
    if (!d) return null;
    const day = Number(d[1]);
    if (previous !== null && day < previous) {
      month += 1;
      if (month === 13) { month = 1; year += 1; }
    }
    previous = day;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  });
}

function parseTable(table, bookingScope) {
  const rows = table?.rows ?? [];
  if (rows.length < 3) return null;
  const monthLabel = rows[0].map(textOf).find(x => /\d{4}年\d{1,2}月/.test(x)) ?? '';
  const dates = buildDates(monthLabel, rows[1].slice(1));
  const rooms = rows.slice(2).map(row => {
    const room = parseRoom(textOf(row[0]));
    return {
      ...room,
      availability: dates.map((date, i) => ({
        date,
        rawStatus: textOf(row[i + 1]),
        status: parseStatus(textOf(row[i + 1]))
      })).filter(x => x.date)
    };
  }).filter(x => x.name);
  return { bookingScope, rooms };
}

try {
  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(config.settleTimeMs ?? 5000);

  const vialLabel = page.getByText('VIALAのみ', { exact: false }).first();
  if (await vialLabel.count()) {
    try { await vialLabel.click({ timeout: 3000 }); await page.waitForTimeout(2000); } catch {}
  }

  await page.evaluate(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(node => /VIALA/i.test((node.textContent ?? '').normalize('NFKC')));
    for (const heading of headings) {
      const container = heading.closest('section,article,li,div') ?? heading.parentElement;
      const clickable = heading.closest('button,[role="button"]') ?? container?.querySelector('button,[role="button"]') ?? heading;
      try { clickable.click(); await sleep(300); } catch {}
    }
  });
  await page.waitForTimeout(4000);

  const snapshot = await page.evaluate(() => {
    const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(x => clean(x.textContent)).filter(Boolean);
    const tables = [...document.querySelectorAll('table')].map(table => ({
      rows: [...table.querySelectorAll('tr')].map(row =>
        [...row.querySelectorAll('th,td')].map(cell => ({ text: clean(cell.textContent) }))
      ).filter(row => row.some(cell => cell.text))
    })).filter(table => table.rows.length);
    return { title: document.title, url: location.href, headings, tables };
  });

  const names = snapshot.headings.filter(x => /VIALA/i.test(norm(x)));
  const facilities = names.map((name, i) => ({
    name: norm(name),
    home: parseTable(snapshot.tables[i * 2], 'home'),
    mutual: parseTable(snapshot.tables[i * 2 + 1], 'mutual')
  }));

  for (const facility of facilities) {
    const homeRooms = new Map((facility.home?.rooms ?? []).map(room => [norm(room.name), room]));
    for (const room of facility.mutual?.rooms ?? []) {
      const home = homeRooms.get(norm(room.name));
      const homeByDate = new Map((home?.availability ?? []).map(slot => [slot.date, slot]));
      for (const slot of room.availability) {
        if (slot.status !== 'follow_home') continue;
        const ref = homeByDate.get(slot.date);
        if (ref) {
          slot.effectiveStatus = ref.status;
          slot.effectiveRawStatus = ref.rawStatus;
          slot.followHome = true;
        }
      }
    }
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    title: snapshot.title,
    url: snapshot.url,
    facilities,
    diagnostics: {
      headingCount: names.length,
      tableCount: snapshot.tables.length,
      parsedFacilityCount: facilities.length
    }
  };
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/latest.json', JSON.stringify(result, null, 2));
  await page.screenshot({ path: 'data/latest.png', fullPage: true });
  console.log(JSON.stringify(result.diagnostics));
} finally {
  await browser.close();
}
