// The game-API client: URL building, result normalization, and the rules it lives under.
//
// Run with:  node src/utils/aw-api.test.js
//
// The injected fake network function is still scheduled through the REAL rate gate
// (aw-api routes every call through AWGameRate even under injection — a test hook that
// bypassed the gate would be a ready-made hole in the five-per-second agreement), so
// this suite uses real timers and takes a couple of seconds. That is by design.
//
// All request/response data below is synthetic. The repo is public: no captured game
// responses, no real player names.

const path = require('path');
const fs = require('fs');

const AWApi = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'aw-api.js'));
const R = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-rate-limit.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// ── Fake network ──────────────────────────────────────────────────────────────
// Set `nextResponse` before each call; the recorder captures what aw-api sent.
const calls = [];
let nextResponse = null;
AWApi._setFetch((url, init) => {
    calls.push({ url, init });
    if (typeof nextResponse === 'function') return nextResponse(url, init);
    return nextResponse;
});
const last = () => calls[calls.length - 1];

const respond = (status, body, contentType) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: h => (h && h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
});
const jsonRes = (data, status = 200) => respond(status, JSON.stringify(data), 'application/json; charset=utf-8');

(async () => {
    R.reset();

    console.log('── URL building ' + '─'.repeat(60));
    nextResponse = jsonRes([]);
    await AWApi.getSolarSystems();
    ok('getSolarSystems hits /api/v1/SolarSystem', last().url === '/api/v1/SolarSystem', last().url);

    nextResponse = jsonRes({ id: 731 });
    await AWApi.getSolarSystem(731);
    ok('getSolarSystem(id) hits /api/v1/SolarSystem/{id}', last().url === '/api/v1/SolarSystem/731', last().url);

    nextResponse = jsonRes([]);
    await AWApi.getSystemPlanets('731');
    ok('getSystemPlanets(id) hits /api/v1/SolarSystem/{id}/planets',
        last().url === '/api/v1/SolarSystem/731/planets', last().url);

    nextResponse = jsonRes({ totalSeconds: 4242 });
    await AWApi.getTravelTime({ fromSystem: 731, fromPlanetIndex: 2, toSystem: 745, toPlanetIndex: 7, energyLevel: 13 });
    {
        const [p, qs] = last().url.split('?');
        const q = new URLSearchParams(qs);
        ok('getTravelTime hits /api/v1/Fleet/travelTime', p === '/api/v1/Fleet/travelTime', last().url);
        ok('and carries all five spec parameters',
            q.get('fromSystem') === '731' && q.get('fromPlanetIndex') === '2'
            && q.get('toSystem') === '745' && q.get('toPlanetIndex') === '7'
            && q.get('energyLevel') === '13', last().url);
    }

    nextResponse = jsonRes([]);
    await AWApi.searchBattleReports({
        'FirstParty.AllianceId': 42,
        OrderBy: 'DateTime',
        OrderDirection: 'Descending',
        Take: 50,
        'SecondParty.AllianceId': null,
        BattleDateFrom: undefined,
    });
    {
        const [p, qs] = last().url.split('?');
        const q = new URLSearchParams(qs);
        ok('searchBattleReports hits /api/v1/BattleReport/search', p === '/api/v1/BattleReport/search', last().url);
        ok('dotted spec names pass through verbatim', q.get('FirstParty.AllianceId') === '42', last().url);
        ok('and null/undefined params are omitted, never sent as text',
            !q.has('SecondParty.AllianceId') && !q.has('BattleDateFrom') && !/undefined|null/.test(qs), last().url);
        ok('ordering and paging params survive',
            q.get('OrderBy') === 'DateTime' && q.get('OrderDirection') === 'Descending' && q.get('Take') === '50', last().url);
    }

    console.log('\n── Result normalization ' + '─'.repeat(52));
    nextResponse = jsonRes({ id: 731, x: 4, y: -9 });
    const good = await AWApi.getSolarSystem(731);
    ok('a JSON 200 is {ok:true, data}', good.ok === true && good.data.id === 731 && good.data.y === -9, good);

    nextResponse = respond(200, '   ', 'application/json');
    const empty = await AWApi.getSolarSystem(17);
    ok('a 2xx with an empty body is {ok:true, data:null}', empty.ok === true && empty.data === null, empty);

    nextResponse = jsonRes({ title: 'System not found' }, 404);
    const notFound = await AWApi.getSolarSystem(9999);
    ok('a JSON 404 is {ok:false, status:404, reason:"http"} — status verbatim for the caller',
        notFound.ok === false && notFound.status === 404 && notFound.reason === 'http', notFound);

    nextResponse = jsonRes({ title: 'Forbidden' }, 403);
    const forbidden = await AWApi.getSolarSystem(17);
    ok('a JSON 403 keeps its status too', forbidden.status === 403 && forbidden.reason === 'http', forbidden);

    nextResponse = () => { throw new Error('boom'); };
    const network = await AWApi.getSolarSystems();
    ok('a thrown fetch is {ok:false, status:0, reason:"network"} — resolved, never rejected',
        network.ok === false && network.status === 0 && network.reason === 'network', network);

    nextResponse = respond(200, 'this is not json', 'application/json');
    const garbage = await AWApi.getSolarSystems();
    ok('a 2xx non-JSON non-HTML body is reason:"parse"',
        garbage.ok === false && garbage.status === 200 && garbage.reason === 'parse', garbage);

    console.log('\n── An HTML body means a login page, not a parse error ' + '─'.repeat(22));
    // requireAuth redirects to the hub login page and fetch follows it into a 200; the
    // game's Identity login page does the same. Synthetic markup, no real page captured.
    nextResponse = respond(200, '<!DOCTYPE html><html><head><title>Sign in</title></head><body>login</body></html>',
        'text/html; charset=utf-8');
    const session = await AWApi.getSolarSystems();
    ok('text/html is {ok:false, reason:"session"} even on a 200',
        session.ok === false && session.status === 200 && session.reason === 'session', session);

    nextResponse = respond(200, '\n  <html><body>redirected to login</body></html>', null);
    const sniffed = await AWApi.getSolarSystems();
    ok('an HTML body with no content-type header is sniffed, same answer',
        sniffed.ok === false && sniffed.reason === 'session', sniffed);

    console.log('\n── Every call went through the rate gate ' + '─'.repeat(35));
    // The injected fake network above replaced the transport, not the gate: each of the
    // requests this suite made had to take a slot in AWGameRate's rolling window.
    const snap = R.snapshot();
    ok('the gate counted every request this suite sent', snap.sent === calls.length, snap);
    ok('and never let more than five start in one second', snap.maxObservedPerSecond <= 5, snap);

    console.log('\n── mapPlanetsToSyncPayload: the ONE API→/sync/system mapper ' + '─'.repeat(16));
    // Synthetic planets in the published spec's Planet shape.
    const apiPlanets = [
        {
            id: 9001, index: 1, name: 'Prime', ownerId: 501, ownerName: 'Zenobia',
            allianceId: 77, allianceTag: 'SYNTH', populationLevel: 18, starbaseLevel: 4,
            isUnknownOwner: false, hasSiege: false, starbaseOrders: [{ id: 3, canBeChanged: true }],
        },
        {
            id: 9002, index: 2, name: null, ownerId: null, ownerName: null,
            allianceId: null, allianceTag: null, populationLevel: 0, starbaseLevel: 0,
            isUnknownOwner: false, hasSiege: false, starbaseOrders: [],
        },
        {
            id: 9003, index: 3, name: '?', ownerId: null, ownerName: null,
            allianceId: null, allianceTag: null, populationLevel: 0, starbaseLevel: 0,
            isUnknownOwner: true, hasSiege: true, starbaseOrders: null,
        },
        {
            id: 9004, index: 4, name: 'Lone', ownerId: 502, ownerName: 'Tarkin',
            allianceId: null, allianceTag: null, populationLevel: 7, starbaseLevel: 0,
            isUnknownOwner: false, hasSiege: true, starbaseOrders: [],
        },
    ];
    const payload = AWApi.mapPlanetsToSyncPayload('731', apiPlanets);
    ok('system_id is an integer even from a string input', payload.system_id === 731, payload.system_id);
    ok('every planet is mapped', payload.planets.length === 4, payload.planets.length);
    const [p1, p2, p3, p4] = payload.planets;
    ok('id→game_planet_id, index→planet_index', p1.game_planet_id === 9001 && p1.planet_index === 1, p1);
    ok('populationLevel→population, starbaseLevel→starbase', p1.population === 18 && p1.starbase === 4, p1);
    ok('owner carries {id, name, alliance_id, alliance_tag}',
        p1.owner && p1.owner.id === 501 && p1.owner.name === 'Zenobia'
        && p1.owner.alliance_id === 77 && p1.owner.alliance_tag === 'SYNTH', p1.owner);
    ok('an empty planet has owner null', p2.owner === null, p2.owner);
    ok('an alliance-less owner keeps explicit nulls, not undefined',
        p4.owner && p4.owner.alliance_id === null && p4.owner.alliance_tag === null, p4.owner);
    ok('isUnknownOwner→is_unknown', p3.is_unknown === true && p1.is_unknown === false, [p3.is_unknown, p1.is_unknown]);
    ok('hasSiege→is_sieged as 0/1', p3.is_sieged === 1 && p4.is_sieged === 1 && p1.is_sieged === 0,
        payload.planets.map(p => p.is_sieged));
    ok('has_fleet is null — the API says nothing about fleets, so nothing is fabricated',
        payload.planets.every(p => p.has_fleet === null), p1.has_fleet);
    ok('the body matches the existing /sync/system shape (fleets present, empty)',
        Array.isArray(payload.fleets) && payload.fleets.length === 0, payload.fleets);
    const degenerate = AWApi.mapPlanetsToSyncPayload(5, null);
    ok('a non-array planets answer maps to an empty, well-formed body',
        degenerate.system_id === 5 && Array.isArray(degenerate.planets) && degenerate.planets.length === 0, degenerate);

    console.log('\n── Regression: name/ownerName are NOT bare in the real API ' + '─'.repeat(15));
    // Confirmed against a real /api/v1/Map/sectors response (2026-08-30): p.name is
    // "Rasaben #10" (bare name + the SAME index this row already carries separately as
    // p.index) and p.ownerName is "MrChuckleupagus [SSPX]" (bare name + the SAME tag this
    // row already carries separately as p.allianceTag). Before this fix both were used
    // verbatim — every caller that already appends "#{index}" or "[{tag}]" itself would
    // double up, and players.name would get permanently corrupted with a baked-in
    // alliance suffix the first time this ever synced real data (it never had, prior to
    // this fix — confirmed no "[...]"-suffixed player name existed in production).
    const real = AWApi.mapPlanetsToSyncPayload(288, [{
        id: 16714, index: 10, name: 'Rasaben #10', ownerId: 40, ownerName: 'MrChuckleupagus [SSPX]',
        allianceId: 9, allianceTag: 'SSPX', populationLevel: 17, starbaseLevel: 10,
        isUnknownOwner: false, hasSiege: false, starbaseOrders: [],
    }]);
    ok('planet name has the trailing "#{index}" stripped back to bare',
        real.planets[0].name === 'Rasaben', real.planets[0].name);
    ok('owner name has the trailing "[{tag}]" stripped back to bare',
        real.planets[0].owner.name === 'MrChuckleupagus', real.planets[0].owner);
    ok('alliance_tag itself is untouched (it was already bare)',
        real.planets[0].owner.alliance_tag === 'SSPX', real.planets[0].owner);

    const noAlliance = AWApi.mapPlanetsToSyncPayload(50, [{
        id: 17575, index: 10, name: 'Ras Alhague #10', ownerId: 407, ownerName: 'Omniwalker',
        allianceId: null, allianceTag: null, populationLevel: 5, starbaseLevel: 6,
        isUnknownOwner: false, hasSiege: false, starbaseOrders: [],
    }]);
    ok('an owner with no alliance (no bracket suffix to begin with) is left exactly as-is',
        noAlliance.planets[0].owner.name === 'Omniwalker', noAlliance.planets[0].owner);

    console.log('\n── getMapSectors: builds the right query string ' + '─'.repeat(28));
    calls.length = 0;
    nextResponse = jsonRes([]);
    const sectorsRes = await AWApi.getMapSectors({ x1: -30, y1: -30, x2: 30, y2: 30 });
    ok('getMapSectors resolves ok', sectorsRes.ok === true, sectorsRes);
    ok('the request path carries all four bounds', /\/api\/v1\/Map\/sectors\?/.test(calls[0].url)
        && /x1=-30/.test(calls[0].url) && /y1=-30/.test(calls[0].url)
        && /x2=30/.test(calls[0].url) && /y2=30/.test(calls[0].url), calls[0].url);

    console.log('\n── searchAlliances / searchSolarSystems: query strings ' + '─'.repeat(20));
    nextResponse = jsonRes([]);
    calls.length = 0;
    const allianceRes = await AWApi.searchAlliances({ q: 'Star', limit: 10 });
    ok('searchAlliances resolves ok', allianceRes.ok === true, allianceRes);
    ok('the request path is Alliance/search with q and limit', /\/api\/v1\/Alliance\/search\?/.test(calls[0].url)
        && /q=Star/.test(calls[0].url) && /limit=10/.test(calls[0].url), calls[0].url);

    nextResponse = jsonRes([]);
    calls.length = 0;
    const systemRes = await AWApi.searchSolarSystems({ q: 'Rana', limit: 5 });
    ok('searchSolarSystems resolves ok', systemRes.ok === true, systemRes);
    ok('the request path is SolarSystem/search with q and limit', /\/api\/v1\/SolarSystem\/search\?/.test(calls[0].url)
        && /q=Rana/.test(calls[0].url) && /limit=5/.test(calls[0].url), calls[0].url);

    console.log('\n── getPlayers / getPlayer / searchPlayers ' + '─'.repeat(30));
    nextResponse = jsonRes([]);
    calls.length = 0;
    const listRes = await AWApi.getPlayers();
    ok('getPlayers resolves ok', listRes.ok === true, listRes);
    ok('the request path is plain /api/v1/Player, no query string', calls[0].url === '/api/v1/Player', calls[0].url);

    nextResponse = jsonRes({ id: 701 });
    calls.length = 0;
    const detailRes = await AWApi.getPlayer(701);
    ok('getPlayer resolves ok', detailRes.ok === true, detailRes);
    ok('the request path includes the id', calls[0].url === '/api/v1/Player/701', calls[0].url);

    nextResponse = jsonRes([]);
    calls.length = 0;
    const searchRes = await AWApi.searchPlayers({ q: 'Cave', limit: 15 });
    ok('searchPlayers resolves ok', searchRes.ok === true, searchRes);
    ok('the request path is Player/search with q and limit', /\/api\/v1\/Player\/search\?/.test(calls[0].url)
        && /q=Cave/.test(calls[0].url) && /limit=15/.test(calls[0].url), calls[0].url);

    console.log('\n── mapPlanetsToSyncPayload also carries planet name ' + '─'.repeat(23));
    const withName = AWApi.mapPlanetsToSyncPayload('1', [
        { id: 1, index: 1, name: 'Rana', ownerId: null, ownerName: null, allianceId: null,
          allianceTag: null, populationLevel: 0, starbaseLevel: 0, isUnknownOwner: false,
          hasSiege: false, starbaseOrders: [] },
    ]);
    ok('name is carried through to the mapped planet', withName.planets[0].name === 'Rana', withName.planets[0]);

    console.log('\n── mapSolarSystemsToSyncPayload: the ONE API→/sync/galaxy mapper ' + '─'.repeat(12));
    // Synthetic systems in the getSolarSystems/searchSolarSystems shape.
    const apiSystems = [
        { id: 1, name: 'Rana', fullName: 'Rana Prime', info: 'A quiet system', populationLevel: 3, x: 4, y: -9 },
        { id: 2, name: 'Nowhere', fullName: null, info: null, populationLevel: null, x: null, y: null },
        { id: 3, name: 'Edge', fullName: 42, info: 7, populationLevel: '5', x: 0, y: 0 },
    ];
    const sysPayload = AWApi.mapSolarSystemsToSyncPayload(apiSystems);
    ok('systems without both x and y are dropped', sysPayload.systems.length === 2,
        sysPayload.systems.map(s => s.id));
    ok('id/name/x/y carry through', sysPayload.systems[0].id === 1 && sysPayload.systems[0].name === 'Rana'
        && sysPayload.systems[0].x === 4 && sysPayload.systems[0].y === -9, sysPayload.systems[0]);
    ok('fullName/info/populationLevel map to full_name/info/population_level',
        sysPayload.systems[0].full_name === 'Rana Prime' && sysPayload.systems[0].info === 'A quiet system'
        && sysPayload.systems[0].population_level === 3, sysPayload.systems[0]);
    const edge = sysPayload.systems.find(s => s.id === 3);
    ok('a non-string fullName/info and non-integer populationLevel are coerced to null, not passed through',
        edge.full_name === null && edge.info === null && edge.population_level === null, edge);
    const degenerateSystems = AWApi.mapSolarSystemsToSyncPayload(null);
    ok('a non-array systems answer maps to an empty, well-formed body',
        Array.isArray(degenerateSystems.systems) && degenerateSystems.systems.length === 0, degenerateSystems);

    console.log('\n── mapSectorAlliancesToSyncPayload: the ONE API→/sync/alliances-from-map mapper ' + '─'.repeat(3));
    // Real shape confirmed against a live /api/v1/Map/sectors response (2026-08-30):
    // {id, name, tag, color} — no full_name/member_count, unlike Alliance/search. The SAME
    // alliance can appear in more than one sector (it holds territory across several).
    const apiSectors = [
        { id: '-1/-1', alliances: [{ id: 14, name: 'Alliance Orange', tag: 'AO', color: '#FF8C00' }], solarSystems: [] },
        { id: '-1/0', alliances: [{ id: 14, name: 'Alliance Orange', tag: 'AO', color: '#FF8C00' }, { id: 9, name: 'SSPX', tag: 'SSPX', color: '#00F' }], solarSystems: [] },
        { id: '0/0', solarSystems: [] }, // a sector with no alliances[] at all
    ];
    const alliancePayload = AWApi.mapSectorAlliancesToSyncPayload(apiSectors);
    ok('the same alliance appearing in two sectors is deduped to one entry',
        alliancePayload.alliances.length === 2, alliancePayload.alliances.map(a => a.id));
    const orange = alliancePayload.alliances.find(a => a.id === 14);
    ok('id/name/tag carry through', orange && orange.name === 'Alliance Orange' && orange.tag === 'AO', orange);
    ok('color is not carried through — not a column the hub tracks', orange && !('color' in orange), orange);
    const degenerateSectors = AWApi.mapSectorAlliancesToSyncPayload(null);
    ok('a non-array sectors answer maps to an empty, well-formed body',
        Array.isArray(degenerateSectors.alliances) && degenerateSectors.alliances.length === 0, degenerateSectors);
    const noAlliancesField = AWApi.mapSectorAlliancesToSyncPayload([{ id: '0/0', solarSystems: [] }]);
    ok('a sector with no alliances[] field at all does not throw, just contributes nothing',
        noAlliancesField.alliances.length === 0, noAlliancesField);

    console.log('\n── mapPlayersToSyncPayload: the ONE API→/sync/player-list mapper ' + '─'.repeat(12));
    // Synthetic players in the getPlayers/searchPlayers (ListPlayer) shape.
    const apiPlayers = [
        {
            id: 601, name: 'Zenobia', allianceId: 77, isActivePlayer: true,
            joinedAt: '2026-08-01T00:00:00Z', playerLevel: 12, playsFromCountryCode: 'US',
            pointsScored: 5000, rank: 3,
        },
        {
            id: 602, name: null, allianceId: null, isActivePlayer: false,
            joinedAt: null, playerLevel: null, playsFromCountryCode: null,
            pointsScored: null, rank: null,
        },
    ];
    const playersPayload = AWApi.mapPlayersToSyncPayload(apiPlayers);
    ok('every player is mapped', playersPayload.players.length === 2, playersPayload.players.length);
    const [pl1, pl2] = playersPayload.players;
    ok('id/name/alliance_id/level/points/rank/country/joined carry through',
        pl1.id === 601 && pl1.name === 'Zenobia' && pl1.alliance_id === 77 && pl1.level === 12
        && pl1.points === 5000 && pl1.rank === 3 && pl1.country === 'US'
        && pl1.joined === '2026-08-01T00:00:00Z', pl1);
    ok('isActivePlayer→is_active_player as a real boolean', pl1.is_active_player === true, pl1);
    ok('missing/null fields are coerced to null, not undefined or NaN',
        pl2.name === null && pl2.alliance_id === null && pl2.level === null && pl2.points === null
        && pl2.rank === null && pl2.country === null && pl2.joined === null
        && pl2.is_active_player === false, pl2);
    const degeneratePlayers = AWApi.mapPlayersToSyncPayload(null);
    ok('a non-array players answer maps to an empty, well-formed body',
        Array.isArray(degeneratePlayers.players) && degeneratePlayers.players.length === 0, degeneratePlayers);

    console.log('\n── mapPlayerDetailToSyncPayload: the ONE API→/sync/player-detail mapper ' + '─'.repeat(5));
    // Real-shaped Player/{id} detail with a FULL intelligenceReport.race object.
    const fullDetail = AWApi.mapPlayerDetailToSyncPayload({
        id: 413, name: 'Someplayer', allianceId: 9, playerLevel: 5, pointsScored: 100,
        rank: 12, playsFromCountryCode: 'DE', isActivePlayer: true, joinedAt: '2026-08-01T00:00:00Z',
        numberOfLogins: 40, lastActivityAt: '2026-08-30T10:00:00Z', lastLoginAt: '2026-08-30T09:00:00Z',
        resignedAt: null, numberOfBattles: 3, battleLuckiness: 1.2, multiStatus: 'clean',
        isTopPermanentRanker: false, hasSupporterBadge: true, supporterType: 'gold',
        intelligenceReport: {
            biologyLevel: 10, economyLevel: 11, energyLevel: 12, mathematicsLevel: 13,
            physicsLevel: 14, socialLevel: 15, tradeBonus: 16, activeArtefact: { name: 'Relic' },
            race: { growth: 1, science: 2, culture: 3, production: 4, speed: 5, attack: 6, defense: 7, trader: 8, sul: 9 },
        },
    });
    ok('id/name/alliance_id/level/points/ranking/country/joined carry through',
        fullDetail.id === 413 && fullDetail.name === 'Someplayer' && fullDetail.alliance_id === 9
        && fullDetail.level === 5 && fullDetail.points === 100 && fullDetail.ranking === 12
        && fullDetail.country === 'DE' && fullDetail.joined === '2026-08-01T00:00:00Z', fullDetail);
    ok('has_intel is 1 when intelligenceReport is present', fullDetail.has_intel === 1, fullDetail);
    ok('every race_* field carries through when the race sub-object is complete',
        fullDetail.race_growth === 1 && fullDetail.race_sul === 9, fullDetail);
    ok('artefact is JSON-stringified from activeArtefact',
        fullDetail.artefact === JSON.stringify({ name: 'Relic' }), fullDetail.artefact);

    // Regression for the real production crash (2026-08-30): intel.race present but
    // missing ONE bonus field (growth) must map to null, never to undefined — a bare
    // undefined is dropped entirely by JSON.stringify on the way to the server, which
    // crashed better-sqlite3's named-parameter binding.
    const partialRaceDetail = AWApi.mapPlayerDetailToSyncPayload({
        id: 414, name: 'Otherplayer', allianceId: null, playerLevel: 5, pointsScored: 100,
        rank: null, playsFromCountryCode: null, isActivePlayer: true, joinedAt: null,
        numberOfLogins: null, lastActivityAt: null, lastLoginAt: null, resignedAt: null,
        numberOfBattles: null, battleLuckiness: null, multiStatus: null,
        isTopPermanentRanker: false, hasSupporterBadge: false, supporterType: null,
        intelligenceReport: {
            biologyLevel: 1, economyLevel: 1, energyLevel: 1, mathematicsLevel: 1,
            physicsLevel: 1, socialLevel: 1, tradeBonus: 1, activeArtefact: null,
            race: { science: 2, culture: 3, production: 4, speed: 5, attack: 6, defense: 7, trader: 8, sul: 9 }, // growth omitted
        },
    });
    ok('a race sub-object missing one field maps that field to null, not undefined',
        partialRaceDetail.race_growth === null, partialRaceDetail.race_growth);
    ok('the field is an own, enumerable key (JSON.stringify will not drop it)',
        Object.prototype.hasOwnProperty.call(partialRaceDetail, 'race_growth')
        && JSON.parse(JSON.stringify(partialRaceDetail)).race_growth === null, partialRaceDetail);

    const noIntelDetail = AWApi.mapPlayerDetailToSyncPayload({
        id: 415, name: 'NoIntel', allianceId: null, playerLevel: 1, pointsScored: 0,
        rank: null, playsFromCountryCode: null, isActivePlayer: true, joinedAt: null,
        numberOfLogins: null, lastActivityAt: null, lastLoginAt: null, resignedAt: null,
        numberOfBattles: null, battleLuckiness: null, multiStatus: null,
        isTopPermanentRanker: false, hasSupporterBadge: false, supporterType: null,
        intelligenceReport: null,
    });
    ok('has_intel is 0 and every intel/race field is null when there is no intelligenceReport',
        noIntelDetail.has_intel === 0 && noIntelDetail.biology === null && noIntelDetail.race_growth === null,
        noIntelDetail);

    console.log('\n── Source scan: the rules this file lives under ' + '─'.repeat(28));
    // Comments stripped first so a comment describing an old rule can never trip these.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'aw-api.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    ok('no import/export statements — Node must be able to require() it',
        !/^\s*(import|export)\b/m.test(src));
    ok('no bare fetch() anywhere — AWGameRate is the only transport',
        !/\bfetch\s*\(/.test(src));
    ok('it really routes through AWGameRate.gameFetch',
        /AWGameRate/.test(src) && /\.gameFetch\(/.test(src));
    ok('a missing gate in the browser fails loudly, by name',
        /throw new Error\([^)]*AWGameRate/.test(src));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
