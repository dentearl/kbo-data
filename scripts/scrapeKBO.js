/**
 * KBO Schedule & Game Results Scraper
 * 
 * Fetches official regular season schedule and box scores from the KBO web service
 * (koreabaseball.com/ws/Schedule.asmx/GetScheduleList), normalizes game outcomes
 * (including tie/draw games and cancellations), and outputs production-grade JSON
 * for the baseball division race visualization.
 * 
 * 
 * ARCHITECTURAL CONSTRAINT FOR AI AGENTS & DEVELOPERS:
 * This scraper script is intentionally 100% self-contained with ZERO internal repository imports.
 * It must ONLY import Node.js built-ins (node:fs, node:path, node:url).
 * DO NOT import from ../src/ or couple this script to frontend constants.
 * It is deployed and executed independently in standalone scraper repositories (e.g. kbo-data-repo).
 * Parity between KBO_TEAM_MAPPING and src/constants/kboTeams.js is enforced by tests/scraperConsistency.test.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const KBO_TEAM_MAPPING = {
  'KIA': { id: 2001, abbrev: 'KIA', name: 'KIA Tigers', nativeName: 'KIA 타이거즈' },
  'HT':  { id: 2001, abbrev: 'KIA', name: 'KIA Tigers', nativeName: 'KIA 타이거즈' },
  'KT':  { id: 2002, abbrev: 'KT',  name: 'KT Wiz', nativeName: 'KT 위즈' },
  'LG':  { id: 2003, abbrev: 'LG',  name: 'LG Twins', nativeName: 'LG 트윈스' },
  'NC':  { id: 2004, abbrev: 'NC',  name: 'NC Dinos', nativeName: 'NC 다이노스' },
  'SSG': { id: 2005, abbrev: 'SSG', name: 'SSG Landers', nativeName: 'SSG 랜더스' },
  'SK':  { id: 2005, abbrev: 'SSG', name: 'SSG Landers', nativeName: 'SSG 랜더스' },
  '두산': { id: 2006, abbrev: 'DOO', name: 'Doosan Bears', nativeName: '두산 베어스' },
  'OB':  { id: 2006, abbrev: 'DOO', name: 'Doosan Bears', nativeName: '두산 베어스' },
  '롯데': { id: 2007, abbrev: 'LOT', name: 'Lotte Giants', nativeName: '롯데 자이언츠' },
  'LT':  { id: 2007, abbrev: 'LOT', name: 'Lotte Giants', nativeName: '롯데 자이언츠' },
  '삼성': { id: 2008, abbrev: 'SAM', name: 'Samsung Lions', nativeName: '삼성 라이온즈' },
  'SS':  { id: 2008, abbrev: 'SAM', name: 'Samsung Lions', nativeName: '삼성 라이온즈' },
  '키움': { id: 2009, abbrev: 'KIW', name: 'Kiwoom Heroes', nativeName: '키움 히어로즈' },
  'WO':  { id: 2009, abbrev: 'KIW', name: 'Kiwoom Heroes', nativeName: '키움 히어로즈' },
  '한화': { id: 2010, abbrev: 'HAN', name: 'Hanwha Eagles', nativeName: '한화 이글스' },
  'HH':  { id: 2010, abbrev: 'HAN', name: 'Hanwha Eagles', nativeName: '한화 이글스' }
};

const KBO_ENDPOINT = 'https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList';
const KBO_REFERER = 'https://www.koreabaseball.com/Schedule/Schedule.aspx';

/**
 * Resolves raw team identifier (Hangul or Roman abbrev) to canonical team object
 */
export function resolveKboTeam(rawName) {
  if (!rawName) return null;
  const trimmed = rawName.trim();
  const direct = KBO_TEAM_MAPPING[trimmed];
  if (direct) return direct;

  const lower = trimmed.toLowerCase();
  for (const team of Object.values(KBO_TEAM_MAPPING)) {
    if (
      (team.name && (team.name.toLowerCase() === lower || team.name.toLowerCase().includes(lower) || lower.includes(team.name.toLowerCase()))) ||
      (team.abbrev && team.abbrev.toLowerCase() === lower) ||
      (team.nativeName && (team.nativeName === trimmed || trimmed.includes(team.nativeName) || team.nativeName.includes(trimmed)))
    ) {
      return team;
    }
  }

  // Partial or fuzzy match fallback on mapping keys (e.g. Hangul city/short name like '두산', '삼성')
  for (const [key, val] of Object.entries(KBO_TEAM_MAPPING)) {
    if (trimmed.includes(key) || key.includes(trimmed)) {
      return val;
    }
  }
  return null;
}

/**
 * Polite asynchronous delay helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches or reads from cache raw KBO schedule rows for a specific month
 */
async function fetchMonthRaw(season, month, options = {}) {
  const {
    cacheDir = path.join(rootDir, '.kbo_cache'),
    forceRefresh = false,
    ttlHours = 6,
    srIdList = '0,9,6'
  } = options;

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const isPostseasonQuery = srIdList === '3,4,5,7';
  const now = new Date();
  const currentMonthStr = String(now.getMonth() + 1).padStart(2, '0');
  const currentYearStr = String(now.getFullYear());
  const isPastMonth = (season < currentYearStr) || (season === currentYearStr && parseInt(month, 10) < parseInt(currentMonthStr, 10));

  let cacheFile = isPostseasonQuery
    ? path.join(cacheDir, `raw_${season}_${month}_postseason.json`)
    : path.join(cacheDir, `raw_${season}_${month}_regular.json`);

  // For immutable past months, fall back to legacy cache file if regular-specific cache doesn't exist yet
  if (!isPostseasonQuery && !fs.existsSync(cacheFile)) {
    const legacyCache = path.join(cacheDir, `raw_${season}_${month}.json`);
    if (fs.existsSync(legacyCache) && isPastMonth) {
      cacheFile = legacyCache;
    }
  }

  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const stats = fs.statSync(cacheFile);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      // Past months never change and are kept indefinitely; active months expire after ttlHours
      if (isPastMonth || ageHours < ttlHours) {
        console.log(`  💾 [Cache Hit] ${season}-${month}${isPostseasonQuery ? ' (Postseason)' : ''} (${isPastMonth ? 'Immutable past month' : `${ageHours.toFixed(1)}h old < ${ttlHours}h TTL`})`);
        const cachedContent = fs.readFileSync(cacheFile, 'utf-8');
        return JSON.parse(cachedContent);
      }
    } catch (err) {
      console.warn(`  ⚠️ Could not read cache for ${season}-${month}: ${err.message}. Refetching.`);
    }
  }

  console.log(`  🌐 [Network Fetch] Requesting ${season}-${month}${isPostseasonQuery ? ' (Postseason)' : ''} from KBO web service...`);
  // Polite courtesy delay before hitting the external server
  await sleep(400);

  const formBody = new URLSearchParams({
    leId: '1',
    srIdList,
    seasonId: String(season),
    gameMonth: month,
    teamId: ''
  });

  const response = await fetch(KBO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': KBO_REFERER,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    },
    body: formBody.toString()
  });

  if (!response.ok) {
    throw new Error(`KBO server HTTP error ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

/**
 * Parses raw KBO service response rows into normalized game objects
 */
export function parseKboScheduleRows(rows = [], seasonYear = '2026') {
  const games = [];
  let currentDate = null;

  rows.forEach(r => {
    const rowCells = r.row || [];
    if (rowCells.length === 0) return;

    // Check for date header cell (e.g. "04.01(수)")
    for (const cell of rowCells) {
      const text = cell.Text || '';
      const dateMatch = text.match(/(\d{2})\.(\d{2})\s*\(/);
      if (dateMatch) {
        const mm = dateMatch[1];
        const dd = dateMatch[2];
        currentDate = `${seasonYear}-${mm}-${dd}`;
        break;
      }
    }

    if (!currentDate) return;

    // Extract game time (e.g. "<b>18:30</b>")
    let gameTime = '18:30';
    for (const cell of rowCells) {
      const timeMatch = (cell.Text || '').match(/<b>(\d{2}:\d{2})<\/b>/);
      if (timeMatch) {
        gameTime = timeMatch[1];
        break;
      }
    }

    // Extract game review link & game ID
    let gameId = null;
    for (const cell of rowCells) {
      const linkMatch = (cell.Text || '').match(/gameId=([A-Za-z0-9_]+)/);
      if (linkMatch) {
        gameId = linkMatch[1];
        break;
      }
    }

    // Check for postseason series indicator across any cell in the row
    let isPostseason = false;
    let seriesType = null;
    for (const cell of rowCells) {
      const text = cell.Text || '';
      if (/WC|와일드카드/i.test(text)) {
        isPostseason = true;
        seriesType = 'wildCard';
        break;
      } else if (/준PO|준플레이/i.test(text)) {
        isPostseason = true;
        seriesType = 'semiPlayoff';
        break;
      } else if (/한국시리즈|KS\s*\d*차전/i.test(text)) {
        isPostseason = true;
        seriesType = 'koreanSeries';
        break;
      } else if (/(?<![A-Za-z])PO\s*\d*차전|(?<!준)플레이오프/i.test(text)) {
        isPostseason = true;
        seriesType = 'playoff';
        break;
      }
    }

    // Find the matchup & score cell (contains "vs" or Class "play")
    const playCell = rowCells.find(c => (c.Class === 'play' || (c.Text && c.Text.includes('vs'))));
    if (!playCell) return;

    const playText = playCell.Text || '';

    // Check for cancellation / rainout / postponement across any cell in the row
    const isCancelled = rowCells.some(c => {
      const t = c.Text || '';
      return t.includes('취소') || t.includes('우천') || t.includes('그라운드');
    });

    // Parse team matchup: <span>AWAY</span><em>...</em><span>HOME</span>
    const teamMatch = playText.match(/<span>([^<]+)<\/span><em>([\s\S]*?)<\/em><span>([^<]+)<\/span>/);
    if (!teamMatch) return;

    const rawAwayName = teamMatch[1].trim();
    const emContent = teamMatch[2].trim();
    const rawHomeName = teamMatch[3].trim();

    const awayTeamMeta = resolveKboTeam(rawAwayName);
    const homeTeamMeta = resolveKboTeam(rawHomeName);

    if (!awayTeamMeta || !homeTeamMeta) {
      console.warn(`Could not resolve teams in matchup: "${rawAwayName}" vs "${rawHomeName}"`);
      return;
    }

    if (!gameId) {
      const cleanDate = currentDate.replace(/-/g, '');
      gameId = `${cleanDate}_${awayTeamMeta.abbrev}_${homeTeamMeta.abbrev}`;
    }

    if (isCancelled) {
      games.push({
        gamePk: gameId,
        gameDate: `${currentDate}T${gameTime}:00+09:00`,
        officialDate: currentDate,
        status: { detailedState: 'Postponed', abstractGameState: 'F' },
        isPostseason,
        ...(seriesType ? { seriesType } : {}),
        teams: {
          away: {
            team: { id: awayTeamMeta.id, name: awayTeamMeta.name, abbrev: awayTeamMeta.abbrev, league: 'KBO', division: 'KBO' },
            score: null,
            isWinner: false
          },
          home: {
            team: { id: homeTeamMeta.id, name: homeTeamMeta.name, abbrev: homeTeamMeta.abbrev, league: 'KBO', division: 'KBO' },
            score: null,
            isWinner: false
          }
        },
        isTie: false,
        isCancelled: true
      });
      return;
    }

    // Parse scores
    // e.g. <span class="lose">2</span><span>vs</span><span class="win">7</span>
    // or <span class="same">5</span><span>vs</span><span class="same">5</span>
    const scoresMatch = emContent.match(/<span[^>]*class=["']?([^"'>]*)["']?[^>]*>(\d+)<\/span>[\s\S]*?<span[^>]*class=["']?([^"'>]*)["']?[^>]*>(\d+)<\/span>/);

    if (!scoresMatch) {
      // Game not yet played or scheduled
      return;
    }

    const awayClass = scoresMatch[1];
    const awayScore = parseInt(scoresMatch[2], 10);
    const homeClass = scoresMatch[3];
    const homeScore = parseInt(scoresMatch[4], 10);

    const isTie = (awayClass.includes('same') || homeClass.includes('same')) || (awayScore === homeScore);
    const homeWin = !isTie && (homeClass.includes('win') || homeScore > awayScore);
    const awayWin = !isTie && (awayClass.includes('win') || awayScore > homeScore);

    games.push({
      gamePk: gameId,
      gameDate: `${currentDate}T${gameTime}:00+09:00`,
      officialDate: currentDate,
      status: { detailedState: 'Final', abstractGameState: 'F' },
      isPostseason,
      ...(seriesType ? { seriesType } : {}),
      teams: {
        away: {
          team: {
            id: awayTeamMeta.id,
            name: awayTeamMeta.name,
            abbrev: awayTeamMeta.abbrev,
            league: 'KBO',
            division: 'KBO'
          },
          score: awayScore,
          isWinner: awayWin
        },
        home: {
          team: {
            id: homeTeamMeta.id,
            name: homeTeamMeta.name,
            abbrev: homeTeamMeta.abbrev,
            league: 'KBO',
            division: 'KBO'
          },
          score: homeScore,
          isWinner: homeWin
        }
      },
      isTie
    });
  });

  return games;
}

/**
 * Default scheduled 2026 KBO Stepladder Gauntlet Postseason structure.
 */
export function getDefault2026KboPostseasonData() {
  return {
    '2026': {
      era: 'kbo_stepladder',
      isStarted: false,
      isComplete: false,
      seeds: {
        1: { id: 2002, name: 'KT Wiz', shortName: 'Wiz' },
        2: { id: 2008, name: 'Samsung Lions', shortName: 'Lions' },
        3: { id: 2001, name: 'KIA Tigers', shortName: 'Tigers' },
        4: { id: 2003, name: 'LG Twins', shortName: 'Twins' },
        5: { id: 2006, name: 'Doosan Bears', shortName: 'Bears' }
      },
      wildCard: {
        name: 'KBO Wild Card Series',
        format: 'Best of 2 (+1 Adv)',
        team4: { id: 2003, name: 'LG Twins', shortName: 'Twins', wins: 1, isWinner: false, isEliminated: false, hasAdvantage: true },
        team5: { id: 2006, name: 'Doosan Bears', shortName: 'Bears', wins: 0, isWinner: false, isEliminated: false },
        isStarted: false,
        isComplete: false,
        games: [
          { game: 1, date: '2026-10-14', away: 'Doosan Bears', home: 'LG Twins' },
          { game: 2, date: '2026-10-15', away: 'Doosan Bears', home: 'LG Twins', ifNeeded: true }
        ]
      },
      semiPlayoff: {
        name: 'KBO Semi-Playoff',
        format: 'Best of 5',
        team3: { id: 2001, name: 'KIA Tigers', shortName: 'Tigers', wins: 0, isWinner: false, isEliminated: false },
        adv: { name: 'Wild Card Winner', shortName: 'WC Winner', wins: 0, isWinner: false, isEliminated: false },
        isStarted: false,
        isComplete: false,
        games: [
          { game: 1, date: '2026-10-17', away: 'Wild Card Winner', home: 'KIA Tigers' },
          { game: 2, date: '2026-10-18', away: 'Wild Card Winner', home: 'KIA Tigers' },
          { game: 3, date: '2026-10-20', away: 'KIA Tigers', home: 'Wild Card Winner' },
          { game: 4, date: '2026-10-21', away: 'KIA Tigers', home: 'Wild Card Winner', ifNeeded: true },
          { game: 5, date: '2026-10-23', away: 'Wild Card Winner', home: 'KIA Tigers', ifNeeded: true }
        ]
      },
      playoff: {
        name: 'KBO Playoff',
        format: 'Best of 5',
        team2: { id: 2008, name: 'Samsung Lions', shortName: 'Lions', wins: 0, isWinner: false, isEliminated: false },
        adv: { name: 'Semi-Playoff Winner', shortName: 'Semi Winner', wins: 0, isWinner: false, isEliminated: false },
        isStarted: false,
        isComplete: false,
        games: [
          { game: 1, date: '2026-10-25', away: 'Semi-Playoff Winner', home: 'Samsung Lions' },
          { game: 2, date: '2026-10-26', away: 'Semi-Playoff Winner', home: 'Samsung Lions' },
          { game: 3, date: '2026-10-28', away: 'Samsung Lions', home: 'Semi-Playoff Winner' },
          { game: 4, date: '2026-10-29', away: 'Samsung Lions', home: 'Semi-Playoff Winner', ifNeeded: true },
          { game: 5, date: '2026-10-31', away: 'Semi-Playoff Winner', home: 'Samsung Lions', ifNeeded: true }
        ]
      },
      koreanSeries: {
        name: 'Korean Series',
        format: 'Best of 7',
        team1: { id: 2002, name: 'KT Wiz', shortName: 'Wiz', wins: 0, isWinner: false, isEliminated: false },
        adv: { name: 'Playoff Winner', shortName: 'PO Winner', wins: 0, isWinner: false, isEliminated: false },
        isStarted: false,
        isComplete: false,
        games: [
          { game: 1, date: '2026-11-02', away: 'Playoff Winner', home: 'KT Wiz' },
          { game: 2, date: '2026-11-03', away: 'Playoff Winner', home: 'KT Wiz' },
          { game: 3, date: '2026-11-05', away: 'KT Wiz', home: 'Playoff Winner' },
          { game: 4, date: '2026-11-06', away: 'KT Wiz', home: 'Playoff Winner' },
          { game: 5, date: '2026-11-07', away: 'KT Wiz', home: 'Playoff Winner', ifNeeded: true },
          { game: 6, date: '2026-11-09', away: 'Playoff Winner', home: 'KT Wiz', ifNeeded: true },
          { game: 7, date: '2026-11-10', away: 'Playoff Winner', home: 'KT Wiz', ifNeeded: true }
        ]
      }
    }
  };
}

/**
 * Builds structured KBO postseason series from playoff events.
 */
export function parseKboPostseason(postseasonGames = [], _regularSeasonGames = [], season = '2026') {
  const sStr = String(season);
  const baseData = getDefault2026KboPostseasonData();
  const seasonPostseason = baseData[sStr] || baseData['2026'];

  if (!Array.isArray(postseasonGames) || postseasonGames.length === 0) {
    return baseData;
  }

  const wcGames = [];
  const semiGames = [];
  const poGames = [];
  const ksGames = [];

  postseasonGames.forEach(g => {
    const rawStage = (g.seriesType || g.series || g.stage || g.round || '').toLowerCase();
    const rawAway = g.away || g.teams?.away?.team?.name || '';
    const rawHome = g.home || g.teams?.home?.team?.name || '';
    const awayTeam = resolveKboTeam(rawAway);
    const homeTeam = resolveKboTeam(rawHome);
    const srId = String(g.srId || '');

    if (srId === '3' || rawStage.includes('wild') || rawStage.includes('wc') || rawStage.includes('와일드')) {
      wcGames.push(g);
    } else if (srId === '4' || rawStage.includes('semi') || rawStage.includes('준플레이')) {
      semiGames.push(g);
    } else if (srId === '5' || rawStage.includes('playoff') || rawStage.includes('po') || (rawStage.includes('플레이오프') && !rawStage.includes('준'))) {
      poGames.push(g);
    } else if (srId === '7' || rawStage.includes('korean') || rawStage.includes('ks') || rawStage.includes('한국시리즈')) {
      ksGames.push(g);
    } else {
      const ids = [awayTeam?.id, homeTeam?.id].filter(Boolean);
      if (ids.includes(2003) && ids.includes(2006)) {
        wcGames.push(g);
      } else if (ids.includes(2001)) {
        semiGames.push(g);
      } else if (ids.includes(2008)) {
        poGames.push(g);
      } else if (ids.includes(2002)) {
        ksGames.push(g);
      } else {
        wcGames.push(g);
      }
    }
  });

  function processSeries(seriesObj, gamesList, winsNeeded, hasAdvantage = false, topTeamProp = 'team4', botTeamProp = 'team5') {
    if (!seriesObj || gamesList.length === 0) return;
    seriesObj.isStarted = true;
    const parsedGames = [];
    let winsTop = hasAdvantage ? 1 : 0;
    let winsBot = 0;

    const topTeam = seriesObj[topTeamProp];
    const botTeam = seriesObj[botTeamProp];

    gamesList.forEach((g, idx) => {
      const rawAway = g.away || g.teams?.away?.team?.name || '';
      const rawHome = g.home || g.teams?.home?.team?.name || '';
      const awayTeam = resolveKboTeam(rawAway);
      const homeTeam = resolveKboTeam(rawHome);
      const awayName = awayTeam?.name || (typeof g.away === 'string' && g.away ? g.away : '') || g.teams?.away?.team?.name || 'Away';
      const homeName = homeTeam?.name || (typeof g.home === 'string' && g.home ? g.home : '') || g.teams?.home?.team?.name || 'Home';
      const awayScore = typeof g.awayScore === 'number' ? g.awayScore : (g.teams?.away?.score ?? null);
      const homeScore = typeof g.homeScore === 'number' ? g.homeScore : (g.teams?.home?.score ?? null);
      const isFinal = Boolean(g.isFinal || (g.status && (g.status.detailedState === 'Final' || g.status.abstractGameState === 'F')));

      let winnerId = null;
      if (isFinal && awayScore !== null && homeScore !== null) {
        if (awayScore > homeScore) {
          winnerId = awayTeam?.id || null;
        } else if (homeScore > awayScore) {
          winnerId = homeTeam?.id || null;
        }
      } else if (g.winnerId) {
        winnerId = g.winnerId;
      }

      parsedGames.push({
        game: idx + 1,
        date: g.officialDate || g.date,
        away: awayName,
        home: homeName,
        awayScore,
        homeScore,
        winnerId,
        isFinal
      });

      const topId = topTeam?.id;
      const botId = botTeam?.id;

      if (winnerId && topId && winnerId === topId) winsTop++;
      else if (winnerId && botId && winnerId === botId) winsBot++;
      else if (winnerId && awayTeam && awayTeam.id === topId) winsTop++;
      else if (winnerId && homeTeam && homeTeam.id === topId) winsTop++;
      else if (winnerId && awayTeam && awayTeam.id === botId) winsBot++;
      else if (winnerId && homeTeam && homeTeam.id === botId) winsBot++;
    });

    // Merge parsed games with scheduled placeholder games to preserve future schedule
    if (Array.isArray(seriesObj.games) && seriesObj.games.length > 0) {
      const mergedGames = seriesObj.games.map((origGame, i) => {
        if (parsedGames[i]) return parsedGames[i];
        return origGame;
      });
      for (let i = seriesObj.games.length; i < parsedGames.length; i++) {
        mergedGames.push(parsedGames[i]);
      }
      seriesObj.games = mergedGames;
    } else {
      seriesObj.games = parsedGames;
    }

    if (topTeam) topTeam.wins = winsTop;
    if (botTeam) botTeam.wins = winsBot;

    if (winsTop >= winsNeeded) {
      seriesObj.isComplete = true;
      seriesObj.winnerId = topTeam?.id;
      if (topTeam) topTeam.isWinner = true;
      if (botTeam) botTeam.isEliminated = true;
    } else if (winsBot >= winsNeeded) {
      seriesObj.isComplete = true;
      seriesObj.winnerId = botTeam?.id;
      if (botTeam) botTeam.isWinner = true;
      if (topTeam) topTeam.isEliminated = true;
    }
  }

  processSeries(seasonPostseason.wildCard, wcGames, 2, true, 'team4', 'team5');

  if (seasonPostseason.wildCard.isComplete && seasonPostseason.wildCard.winnerId) {
    const wcWinnerId = seasonPostseason.wildCard.winnerId;
    const wcWinner = wcWinnerId === seasonPostseason.wildCard.team4?.id
      ? seasonPostseason.wildCard.team4
      : seasonPostseason.wildCard.team5;
    if (seasonPostseason.semiPlayoff && wcWinner) {
      seasonPostseason.semiPlayoff.adv = {
        id: wcWinner.id,
        name: wcWinner.name,
        shortName: wcWinner.shortName || wcWinner.name,
        wins: 0,
        isWinner: false,
        isEliminated: false
      };
      if (Array.isArray(seasonPostseason.semiPlayoff.games)) {
        seasonPostseason.semiPlayoff.games.forEach(g => {
          if (g.away === 'Wild Card Winner' || g.away === seasonPostseason.wildCard.team5?.name) g.away = wcWinner.name;
          if (g.home === 'Wild Card Winner' || g.home === seasonPostseason.wildCard.team5?.name) g.home = wcWinner.name;
        });
      }
    }
  }

  processSeries(seasonPostseason.semiPlayoff, semiGames, 3, false, 'team3', 'adv');

  if (seasonPostseason.semiPlayoff.isComplete && seasonPostseason.semiPlayoff.winnerId) {
    const semiWinnerId = seasonPostseason.semiPlayoff.winnerId;
    const semiWinner = semiWinnerId === seasonPostseason.semiPlayoff.team3?.id
      ? seasonPostseason.semiPlayoff.team3
      : seasonPostseason.semiPlayoff.adv;
    if (seasonPostseason.playoff && semiWinner) {
      seasonPostseason.playoff.adv = {
        id: semiWinner.id,
        name: semiWinner.name,
        shortName: semiWinner.shortName || semiWinner.name,
        wins: 0,
        isWinner: false,
        isEliminated: false
      };
      if (Array.isArray(seasonPostseason.playoff.games)) {
        seasonPostseason.playoff.games.forEach(g => {
          if (g.away === 'Semi-Playoff Winner') g.away = semiWinner.name;
          if (g.home === 'Semi-Playoff Winner') g.home = semiWinner.name;
        });
      }
    }
  }

  processSeries(seasonPostseason.playoff, poGames, 3, false, 'team2', 'adv');

  if (seasonPostseason.playoff.isComplete && seasonPostseason.playoff.winnerId) {
    const poWinnerId = seasonPostseason.playoff.winnerId;
    const poWinner = poWinnerId === seasonPostseason.playoff.team2?.id
      ? seasonPostseason.playoff.team2
      : seasonPostseason.playoff.adv;
    if (seasonPostseason.koreanSeries && poWinner) {
      seasonPostseason.koreanSeries.adv = {
        id: poWinner.id,
        name: poWinner.name,
        shortName: poWinner.shortName || poWinner.name,
        wins: 0,
        isWinner: false,
        isEliminated: false
      };
      if (Array.isArray(seasonPostseason.koreanSeries.games)) {
        seasonPostseason.koreanSeries.games.forEach(g => {
          if (g.away === 'Playoff Winner') g.away = poWinner.name;
          if (g.home === 'Playoff Winner') g.home = poWinner.name;
        });
      }
    }
  }

  processSeries(seasonPostseason.koreanSeries, ksGames, 4, false, 'team1', 'adv');

  if (seasonPostseason.koreanSeries.isComplete && seasonPostseason.koreanSeries.winnerId) {
    seasonPostseason.championId = seasonPostseason.koreanSeries.winnerId;
  }

  seasonPostseason.isStarted = Boolean(
    seasonPostseason.wildCard?.isStarted ||
    seasonPostseason.semiPlayoff?.isStarted ||
    seasonPostseason.playoff?.isStarted ||
    seasonPostseason.koreanSeries?.isStarted
  );
  seasonPostseason.isComplete = Boolean(
    seasonPostseason.koreanSeries?.isComplete
  );

  return { [sStr]: seasonPostseason };
}

/**
 * Updates KBO_POSTSEASON_DATA in src/constants/postseasonSeriesData.js with fresh results
 */
export function updateKboPostseasonSeriesDataConstant(rootDir, kbo2026Data) {
  if (!kbo2026Data) return;
  const targetFile = path.join(rootDir, 'src', 'constants', 'postseasonSeriesData.js');
  if (!fs.existsSync(targetFile)) return;

  try {
    let content = fs.readFileSync(targetFile, 'utf-8');
    const kboRegex = /(const\s+KBO_POSTSEASON_DATA\s*=\s*{[\s\S]*?'2026':\s*){[\s\S]*?}(\s*,\s*['"]2025['"])/;
    if (kboRegex.test(content)) {
      const indentedJson = JSON.stringify(kbo2026Data, null, 6)
        .replace(/\n/g, '\n      ');
      content = content.replace(kboRegex, `$1${indentedJson}$2`);
      fs.writeFileSync(targetFile, content, 'utf-8');
      console.log(`  🔄 [Updated] ${path.relative(rootDir, targetFile)} KBO_POSTSEASON_DATA['2026']`);
    }
  } catch (err) {
    console.warn('  ⚠️ Could not update postseasonSeriesData.js for KBO:', err.message);
  }
}

/**
 * Scrapes and compiles full KBO season into static JSON datasets
 */
export async function scrapeKboSeason(season = '2026', options = {}) {
  const { forceRefresh = false } = options;
  console.log(`🇰🇷 Compiling KBO ${season} Regular Season Data...`);

  // Months active in KBO regular season
  const months = ['03', '04', '05', '06', '07', '08', '09', '10'];
  const regularSeasonGames = [];
  const postseasonGames = [];

  for (const month of months) {
    try {
      const data = await fetchMonthRaw(season, month, { forceRefresh, srIdList: '0,9,6' });
      const monthGames = parseKboScheduleRows(data.rows || [], season);
      const reg = monthGames.filter(g => !g.isPostseason);
      const post = monthGames.filter(g => g.isPostseason);
      console.log(`  Month ${month}: parsed ${reg.length} regular season games${post.length > 0 ? `, ${post.length} postseason games` : ''}`);
      regularSeasonGames.push(...reg);
      postseasonGames.push(...post);
    } catch (err) {
      console.error(`  ❌ Error processing month ${month}:`, err.message);
    }
  }

  // Sort regular season chronologically by officialDate and gamePk
  regularSeasonGames.sort((a, b) => {
    if (a.officialDate !== b.officialDate) {
      return a.officialDate.localeCompare(b.officialDate);
    }
    return String(a.gamePk).localeCompare(String(b.gamePk));
  });

  // Dedicated postseason schedule fetch for October and November
  console.log(`🏆 Compiling KBO ${season} Postseason Data...`);
  const postseasonMonths = ['10', '11'];
  for (const month of postseasonMonths) {
    try {
      const psData = await fetchMonthRaw(season, month, { forceRefresh, srIdList: '3,4,5,7' });
      const psMonthGames = parseKboScheduleRows(psData.rows || [], season);
      psMonthGames.forEach(g => {
        g.isPostseason = true;
        if (!postseasonGames.some(existing => existing.gamePk === g.gamePk)) {
          postseasonGames.push(g);
        }
      });
      console.log(`  Postseason Month ${month}: parsed ${psMonthGames.length} games`);
    } catch (err) {
      console.error(`  ❌ Error processing postseason month ${month}:`, err.message);
    }
  }

  // Sort postseason games chronologically
  postseasonGames.sort((a, b) => {
    if (a.officialDate !== b.officialDate) {
      return a.officialDate.localeCompare(b.officialDate);
    }
    return String(a.gamePk).localeCompare(String(b.gamePk));
  });

  // Defensively ensure no postseason games leak into regular season dataset
  const postseasonPks = new Set(postseasonGames.map(g => g.gamePk));
  const cleanRegularSeasonGames = regularSeasonGames.filter(g => !postseasonPks.has(g.gamePk));

  const finalGames = cleanRegularSeasonGames.filter(g => g.status?.detailedState === 'Final');
  const tieGames = finalGames.filter(g => g.isTie);

  console.log(`\n📊 Season Summary (${season}):`);
  console.log(`   Regular Season Games Recorded: ${cleanRegularSeasonGames.length}`);
  console.log(`   Final Regular Games Completed: ${finalGames.length}`);
  console.log(`   Tie Games: ${tieGames.length}`);
  console.log(`   Postseason Games Recorded: ${postseasonGames.length}`);

  // Summary per team (Regular Season)
  const teamRecords = {};
  finalGames.forEach(g => {
    const home = g.teams.home;
    const away = g.teams.away;

    if (!teamRecords[home.team.name]) teamRecords[home.team.name] = { w: 0, l: 0, t: 0 };
    if (!teamRecords[away.team.name]) teamRecords[away.team.name] = { w: 0, l: 0, t: 0 };

    if (g.isTie) {
      teamRecords[home.team.name].t += 1;
      teamRecords[away.team.name].t += 1;
    } else if (home.isWinner) {
      teamRecords[home.team.name].w += 1;
      teamRecords[away.team.name].l += 1;
    } else if (away.isWinner) {
      teamRecords[away.team.name].w += 1;
      teamRecords[home.team.name].l += 1;
    }
  });

  console.log('\n🏆 Team Standings (W-L-T):');
  Object.entries(teamRecords)
    .sort(([, a], [, b]) => {
      const pctA = (a.w + a.l) > 0 ? a.w / (a.w + a.l) : 0;
      const pctB = (b.w + b.l) > 0 ? b.w / (b.w + b.l) : 0;
      return pctB - pctA;
    })
    .forEach(([team, rec], idx) => {
      const pct = (rec.w + rec.l) > 0 ? (rec.w / (rec.w + rec.l)).toFixed(3) : '.000';
      console.log(`   ${String(idx + 1).padStart(2, ' ')}. ${team.padEnd(16, ' ')} ${rec.w}-${rec.l}-${rec.t}  (${pct})`);
    });

  // Target paths (supports both standalone scraper repo and full web app repo)
  const targets = [];
  const publicDir = path.join(rootDir, 'public', 'data', 'kbo');
  const srcDataDir = path.join(rootDir, 'src', 'data', 'kbo');
  const standaloneDir = path.join(rootDir, 'data', 'kbo');

  if (fs.existsSync(path.join(rootDir, 'public'))) {
    targets.push(path.join(publicDir, `${season}.json`));
  }
  if (fs.existsSync(path.join(rootDir, 'src'))) {
    targets.push(path.join(srcDataDir, `${season}.json`));
  }
  if (targets.length === 0 || fs.existsSync(standaloneDir)) {
    targets.push(path.join(standaloneDir, `${season}.json`));
  }

  targets.forEach(targetFile => {
    const parent = path.dirname(targetFile);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
  });

  const serializedData = JSON.stringify(cleanRegularSeasonGames, null, 2);

  targets.forEach(targetFile => {
    if (fs.existsSync(targetFile)) {
      const existingContent = fs.readFileSync(targetFile, 'utf-8');
      if (existingContent === serializedData) {
        console.log(`  ✨ [No Diff] ${path.relative(rootDir, targetFile)} is already up to date.`);
        return;
      }
    }
    fs.writeFileSync(targetFile, serializedData, 'utf-8');
    console.log(`  💾 [Written] ${path.relative(rootDir, targetFile)} (${(serializedData.length / 1024).toFixed(1)} KB)`);
  });

  // If src/data/kbo exists, also keep the embedded JS file in sync for file:// protocol support
  const embeddedJsTarget = path.join(srcDataDir, `${season}.js`);
  if (fs.existsSync(srcDataDir)) {
    const jsContent = `/**
 * Embedded ${season} KBO Schedule & Results Dataset
 * Enables zero-server local execution (file:/// protocol) without CORS restrictions.
 */
(function() {
  const games = ${serializedData};
  if (typeof window !== "undefined") {
    window.KBO_STATIC_DATA = window.KBO_STATIC_DATA || {};
    window.KBO_STATIC_DATA["${season}"] = games;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = games;
  }
})();
`;
    if (fs.existsSync(embeddedJsTarget) && fs.readFileSync(embeddedJsTarget, 'utf-8') === jsContent) {
      console.log(`  ✨ [No Diff] ${path.relative(rootDir, embeddedJsTarget)} is already up to date.`);
    } else {
      fs.writeFileSync(embeddedJsTarget, jsContent, 'utf-8');
      console.log(`  💾 [Written] ${path.relative(rootDir, embeddedJsTarget)} (${(jsContent.length / 1024).toFixed(1)} KB)`);
    }
  }

  // Compile & Write Postseason Data
  const sStr = String(season);
  const postseasonData = parseKboPostseason(postseasonGames, cleanRegularSeasonGames, sStr);
  const serializedPostseason = JSON.stringify(postseasonData, null, 2);
  const postseasonTargets = [];
  if (fs.existsSync(path.join(rootDir, 'public'))) {
    postseasonTargets.push(path.join(publicDir, 'postseason.json'));
  }
  if (fs.existsSync(path.join(rootDir, 'src'))) {
    postseasonTargets.push(path.join(srcDataDir, 'postseason.json'));
  }
  if (postseasonTargets.length === 0 || fs.existsSync(standaloneDir)) {
    postseasonTargets.push(path.join(standaloneDir, 'postseason.json'));
  }

  postseasonTargets.forEach(targetFile => {
    const parent = path.dirname(targetFile);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(targetFile, serializedPostseason, 'utf-8');
    console.log(`  🏆 [Written] ${path.relative(rootDir, targetFile)} (${(serializedPostseason.length / 1024).toFixed(1)} KB)`);
  });

  // Write Postseason Embedded JS
  if (fs.existsSync(srcDataDir)) {
    const embeddedPostseasonJsTarget = path.join(srcDataDir, 'postseason.js');
    const psJsContent = `/**
 * Embedded KBO Postseason Series Dataset
 * Enables zero-server local execution (file:/// protocol) without CORS restrictions.
 */
(function() {
  const postseason = ${serializedPostseason};
  if (typeof window !== "undefined") {
    window.KBO_POSTSEASON_STATIC = postseason;
    if (window.postseasonSeriesData && window.postseasonSeriesData.POSTSEASON_SERIES_DATA) {
      window.postseasonSeriesData.POSTSEASON_SERIES_DATA.kbo = postseason;
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = postseason;
  }
})();
`;
    fs.writeFileSync(embeddedPostseasonJsTarget, psJsContent, 'utf-8');
    console.log(`  🏆 [Written] ${path.relative(rootDir, embeddedPostseasonJsTarget)} (${(psJsContent.length / 1024).toFixed(1)} KB)`);
  }

  // Update src/constants/postseasonSeriesData.js with synced postseason results if file exists
  updateKboPostseasonSeriesDataConstant(rootDir, postseasonData[sStr] || postseasonData['2026']);

  // Save scrape metadata with timestamp
  saveScrapeMetadata(rootDir, 'kbo', season, cleanRegularSeasonGames);

  return cleanRegularSeasonGames;
}

/**
 * Writes data/<league>/metadata.json and updates src/constants/scrapeMeta.js if present
 */
function saveScrapeMetadata(rootDir, league, season, games) {
  const now = new Date();
  let ptString = '';
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = formatter.formatToParts(now);
    const getP = t => parts.find(p => p.type === t)?.value || '';
    ptString = `${getP('year')}-${getP('month')}-${getP('day')} ${getP('hour')}:${getP('minute')} PT`;
  } catch (_e) {
    ptString = now.toISOString();
  }

  const metaObj = {
    league,
    season: String(season),
    lastUpdated: now.toISOString(),
    lastUpdatedPT: ptString,
    lastScraped: now.toISOString(),
    lastScrapedPT: ptString,
    totalGames: Array.isArray(games) ? games.length : 0,
    completedGames: Array.isArray(games) ? games.filter(g => g.status?.detailedState === 'Final').length : 0
  };

  const serialized = JSON.stringify(metaObj, null, 2);
  const candidateDirs = [
    path.join(rootDir, 'public', 'data', league),
    path.join(rootDir, 'src', 'data', league),
    path.join(rootDir, 'data', league)
  ];

  candidateDirs.forEach(dir => {
    if (fs.existsSync(dir)) {
      const metaPath = path.join(dir, 'metadata.json');
      fs.writeFileSync(metaPath, serialized, 'utf-8');
      console.log(`  ⏱️ [Metadata] ${path.relative(rootDir, metaPath)} (${ptString})`);
    }
  });

  const scrapeMetaFile = path.join(rootDir, 'src', 'constants', 'scrapeMeta.js');
  if (fs.existsSync(scrapeMetaFile)) {
    try {
      let content = fs.readFileSync(scrapeMetaFile, 'utf-8');
      const lgRegex = new RegExp(`(${league}\\s*:\\s*{[\\s\\S]*?lastScraped:\\s*['"])([^'"]+)(['"])`);
      if (lgRegex.test(content)) {
        content = content.replace(lgRegex, `$1${ptString}$3`);
      }
      const isoRegex = new RegExp(`(${league}\\s*:\\s*{[\\s\\S]*?iso:\\s*['"])([^'"]+)(['"])`);
      if (isoRegex.test(content)) {
        content = content.replace(isoRegex, `$1${now.toISOString()}$3`);
      }
      fs.writeFileSync(scrapeMetaFile, content, 'utf-8');
    } catch (_e) {}
  }
}

// CLI Execution entry point
if (process.argv[1] && process.argv[1].endsWith('scrapeKBO.js')) {
  const args = process.argv.slice(2);
  let seasons = ['2026'];
  let forceRefresh = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--season' && args[i + 1]) {
      seasons = [args[i + 1]];
      i++;
    } else if (args[i] === '--seasons' && args[i + 1]) {
      seasons = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--all') {
      seasons = ['2021', '2022', '2023', '2024', '2025', '2026'];
    } else if (args[i] === '--force' || args[i] === '--no-cache') {
      forceRefresh = true;
    }
  }

  (async () => {
    for (const yr of seasons) {
      await scrapeKboSeason(yr, { forceRefresh });
    }
  })()
    .then(() => {
      console.log('\n✅ KBO data extraction complete.');
      process.exit(0);
    })
    .catch(err => {
      console.error('\n❌ KBO scraping failed:', err);
      process.exit(1);
    });
}
