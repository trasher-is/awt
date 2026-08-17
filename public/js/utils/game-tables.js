// Every cost table the game publishes, transcribed ONCE, from docs/game-rules.md.
//
// GENERATED FROM THE DOC. Do not hand-edit a number here. `game-tables.test.js` re-parses
// the markdown tables out of docs/game-rules.md and asserts every value below matches, so
// an edit here that the doc does not agree with fails the suite. If the game changes, fix
// the doc and re-run the generator; the doc is ground truth, per AGENTS.md.
//
// Why this file exists: public/js/ui/build-order.js used to carry its own truncated copies
// (buildings to level 8, population to 7, culture to 9, science to 8). Every empire in that
// sim hit those ceilings inside ~10 days, so a 60-day run converged to the same numbers no
// matter what was fed in.
//
// LOADING: dual-runtime, like travel-model.js — no import/export.
//   • Node:    require('../../public/js/utils/game-tables.js')
//   • Browser: import '../utils/game-tables.js';  then read globalThis.AWTables
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWTables = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Cost to raise the thing ONE level, indexed by the level being reached. Index 0 is a
    // placeholder so that COST[n] is "the cost of level n" with no off-by-one.
    //
    // Starbase levels cost exactly the same as buildings (the two columns in the doc are
    // identical), so there is deliberately no separate starbase cost table.
    const BUILDING = [
        0, 5, 8, 11, 17, 25, 38, 57, 85, 128,
        192, 288, 432, 649, 973, 1460, 2189, 3284, 4926, 7389,
        11084, 16626, 24939, 37409, 56114, 84171, 126256, 189384, 284076, 426113,
        639170
    ];

    // Population growth points needed for each level.
    const POP_GROWTH = [
        0, 0, 21, 57, 111, 183, 273, 381, 507, 651,
        813, 993, 1191, 1407, 1641, 1893, 2163, 2451, 2757, 3081,
        3423, 3783, 4161, 4557, 4971, 5403, 5853, 6321, 6807, 7311,
        7833, 8373, 8931, 9507, 10101, 10713, 11343, 11991, 12657, 13341,
        14043, 14763, 15501, 16257, 17031, 17823, 18633, 19461, 20307, 21171,
        22053, 22953, 23871, 24807, 25761, 26733, 27723, 28731, 29757, 30801,
        31863, 32943, 34041, 35157, 36291, 37443, 38613, 39801, 41007, 42231,
        43473, 44733, 46011, 47307, 48621, 49953, 51303, 52671, 54057, 55461,
        56883, 58323, 59781, 61257, 62751, 64263, 65793, 67341, 68907, 70491,
        72093, 73713, 75351, 77007, 78681, 80373, 82083, 83811, 85557, 87321,
        89103
    ];

    // Culture points needed for each level. Culture level IS the planet cap: culture N
    // permits N planets, so no separate slot table is needed.
    const CULTURE = [
        0, 0, 318, 765, 1315, 2084, 2985, 4059,
        5320, 6785, 8467, 10382, 12547, 14979, 17697, 20721,
        24071, 27768, 31835, 36298, 41179, 46507, 52310, 58616,
        65456, 72863, 79610, 87319, 95415, 103900, 112772, 122032,
        131680, 141715, 152138, 162949, 174148, 185734, 197708, 210069,
        222819, 235956, 249481, 263393, 277693, 292381, 307457, 322920,
        338771, 355010, 371637, 388651, 406053, 423843, 442020, 460585,
        479538, 498879, 518607, 538723, 559227, 580118, 601397, 623064,
        645118, 667561, 690391, 713608, 737214, 761207, 785588, 810356,
        835513, 861057, 886988, 913308, 940015, 967110, 994592, 1022463,
        1050721, 1079366, 1108400, 1137821, 1167630, 1197826, 1228411, 1259383,
        1290742, 1322490, 1354625, 1387148, 1420058, 1453357, 1487043, 1521116,
        1555578, 1590427, 1625664, 1661289, 1697301
    ];

    // Science points needed for each level, shared by all six fields.
    const SCIENCE = [
        0, 29, 74, 138, 221, 325, 451, 603,
        780, 986, 1223, 1492, 1796, 2138, 2520, 2945,
        3415, 3934, 4505, 5131, 5816, 6563, 7377, 8261,
        9221, 10260, 11382, 12595, 13901, 15400, 16715, 18866,
        20863, 23056, 25465, 28109, 31014, 34203, 37705, 41551,
        45774, 50411, 55504, 61096, 67237, 73980, 81385, 89517,
        98447, 108252, 119020, 130845, 143829, 158088, 173746, 190940,
        209821, 230555, 253323, 278326, 305781, 335931, 369039, 405395,
        445319, 489160, 537302, 590169, 648223, 711973, 781978, 858852,
        943269, 1035969, 1137765, 1249549, 1372301, 1507098, 1655122, 1817669,
        1996166, 2192176, 2407420, 2643783, 2903338, 3188361, 3501350, 3845050,
        4222474, 4636931, 5092055, 5591836, 6140655, 6743325, 7405129, 8131869,
        8929917, 9806271, 10768612, 11825379, 12985836
    ];

    // Maximum population per planet, indexed by social level. Index 0 is a real row here
    // (social 0 already allows population 5), not a placeholder.
    const SOCIAL_CAP = [
        5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 11, 12,
        13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25
    ];

    // Experience needed for each player level.
    const PLAYER_LEVEL = [
        0, 5, 27, 65, 114, 175, 245, 326, 415, 513,
        621, 735, 859, 989, 1127, 1273, 1425, 1586, 1752, 1926,
        2106, 2292, 2487, 2685, 2892, 3105, 3322, 3547, 3778, 4014,
        4257, 4506, 4762, 5024, 5293, 5568, 5850, 6138, 6433, 6734,
        7042, 7356, 7677, 8004, 8338, 8678, 9025, 9378, 9738, 10104,
        10477, 10856, 11242, 11634, 12033, 12438, 12850, 13268, 13693, 14124,
        14562, 15006, 15457, 15914, 16378, 16848, 17325, 17808, 18298, 18794,
        19297, 19806, 20322, 20844, 21373, 21908, 22450, 22998, 23553, 24114,
        24682, 25256, 25837, 26424, 27018, 27618, 28225, 28838, 29458, 30084,
        30717, 31356, 32002, 32654, 33313, 33978, 34650, 35328, 36013, 36704,
        36704
    ];

    // Published economy breakpoints as [level, destroyer, cruiser, battleship]. Only these
    // levels change the price. Retained so the test can check destroyerCost() against every
    // row the game actually publishes rather than trusting the closed form.
    const ECONOMY_SHIP = [[0,30,240,600],[4,29,232,580],[7,28,224,560],[10,27,216,540],[14,26,208,520],[17,25,200,500],[20,24,192,480],[24,23,184,460],[27,22,176,440],[30,21,168,420],[34,20,160,400],[37,19,152,380],[40,18,144,360],[44,17,136,340],[47,16,128,320],[50,15,120,300],[54,14,112,280],[57,13,104,260],[60,12,96,240],[64,11,88,220],[67,10,80,200],[70,9,72,180],[74,8,64,160],[77,7,56,140],[80,6,48,120],[84,5,40,100],[87,4,32,80],[90,3,24,60],[94,2,16,40],[97,1,8,20]];

    // Artifact bonuses are fractions, not percentages. One may be active at a time.
    const ARTIFACTS = [
        {"playerLevel":1,"name":"Basalt Monolith 1","growth":0,"science":0,"culture":0.1,"production":0,"basePrice":2500},
        {"playerLevel":2,"name":"Astrolabe 1","growth":0,"science":0.1,"culture":0,"production":0,"basePrice":1225},
        {"playerLevel":3,"name":"Celestial Prism 1","growth":0.1,"science":0,"culture":0,"production":0,"basePrice":1225},
        {"playerLevel":4,"name":"Crystal Rod 1","growth":0.1,"science":0,"culture":0.1,"production":0,"basePrice":7225},
        {"playerLevel":5,"name":"Charcoal Diamond 1","growth":0,"science":0,"culture":0,"production":0.1,"basePrice":2500},
        {"playerLevel":6,"name":"Memory Jar 1","growth":0,"science":0.1,"culture":0,"production":0.1,"basePrice":7225},
        {"playerLevel":7,"name":"Heart Of Rana 1","growth":0.1,"science":0.1,"culture":0.1,"production":0.1,"basePrice":28900},
        {"playerLevel":8,"name":"Basalt Monolith 2","growth":0,"science":0,"culture":0.2,"production":0,"basePrice":10000},
        {"playerLevel":9,"name":"Astrolabe 2","growth":0,"science":0.2,"culture":0,"production":0,"basePrice":4900},
        {"playerLevel":10,"name":"Celestial Prism 2","growth":0.2,"science":0,"culture":0,"production":0,"basePrice":4900},
        {"playerLevel":11,"name":"Crystal Rod 2","growth":0.2,"science":0,"culture":0.2,"production":0,"basePrice":28900},
        {"playerLevel":12,"name":"Charcoal Diamond 2","growth":0,"science":0,"culture":0,"production":0.2,"basePrice":10000},
        {"playerLevel":13,"name":"Memory Jar 2","growth":0,"science":0.2,"culture":0,"production":0.2,"basePrice":28900},
        {"playerLevel":14,"name":"Heart Of Rana 2","growth":0.2,"science":0.2,"culture":0.2,"production":0.2,"basePrice":115600},
        {"playerLevel":15,"name":"Basalt Monolith 3","growth":0,"science":0,"culture":0.3,"production":0,"basePrice":22500},
        {"playerLevel":16,"name":"Astrolabe 3","growth":0,"science":0.3,"culture":0,"production":0,"basePrice":11025},
        {"playerLevel":17,"name":"Celestial Prism 3","growth":0.3,"science":0,"culture":0,"production":0,"basePrice":11025},
        {"playerLevel":18,"name":"Crystal Rod 3","growth":0.3,"science":0,"culture":0.3,"production":0,"basePrice":65025},
        {"playerLevel":19,"name":"Charcoal Diamond 3","growth":0,"science":0,"culture":0,"production":0.3,"basePrice":22500},
        {"playerLevel":20,"name":"Memory Jar 3","growth":0,"science":0.3,"culture":0,"production":0.3,"basePrice":65025},
        {"playerLevel":21,"name":"Heart Of Rana 3","growth":0.3,"science":0.3,"culture":0.3,"production":0.3,"basePrice":260100}
    ];

    // Colony ships and transports cost a flat 60 PP — not scaled by economy.
    const CIVIL_SHIP_PP = 60;

    // Extra colony ships beyond the one that colonises disband into PP, but only once at
    // least TWO are extra: 2 CS yields nothing, 3 CS yields 30, 4 CS yields 45.
    const COLONY_DISBAND_PP = 15;

    // Aggregated cost to go from `from` to `to` in a per-level cost table.
    function aggregate(table, from, to) {
        let sum = 0;
        for (let lvl = from + 1; lvl <= to; lvl++) sum += table[lvl] ?? Infinity;
        return sum;
    }

    // max level a table can express — past this the game wants Supply Units instead of PP
    const maxLevel = table => table.length - 1;

    // Linear and clamped at 1 PP: economy 98-100 stay at the level-97 price, they do not
    // reach 0. Matches all 30 published rows.
    function destroyerCost(economy) {
        return Math.max(1, 30 - Math.floor(economy * 0.3));
    }
    const cruiserCost = economy => destroyerCost(economy) * 8;
    const battleshipCost = economy => destroyerCost(economy) * 20;

    // Population cap for a social level, clamping past the end of the published table.
    function popCap(socialLevel) {
        const lvl = Math.max(0, Math.min(SOCIAL_CAP.length - 1, Math.floor(socialLevel)));
        return SOCIAL_CAP[lvl];
    }

    // Production points returned when a batch of colony ships lands on a free planet.
    function colonyStartingPP(shipsSent) {
        const extra = Math.max(0, Math.floor(shipsSent) - 1);
        return extra >= 2 ? extra * COLONY_DISBAND_PP : 0;
    }

    return {
        BUILDING, POP_GROWTH, CULTURE, SCIENCE, SOCIAL_CAP, PLAYER_LEVEL,
        ECONOMY_SHIP, ARTIFACTS,
        CIVIL_SHIP_PP, COLONY_DISBAND_PP,
        aggregate, maxLevel, popCap, colonyStartingPP,
        destroyerCost, cruiserCost, battleshipCost
    };
});
