export async function scrapeGalaxy() {
    console.log(`[Spy] Initiating galaxy master index scrape from Calculator...`);

    const select = document.getElementById('FromSolarSystemId');
    if (!select) {
        console.warn("[Spy] Could not find the FromSolarSystemId dropdown. Aborting.");
        return;
    }

    const systems = [];
    const options = select.querySelectorAll('option[value]:not([value=""])');

    options.forEach(opt => {
        const id = parseInt(opt.value, 10);
        const text = opt.innerText.trim(); 
        // Example texts: 
        // "Achird [2] (1/-3)"
        // "Difda al Auwel [34] (10/1)"
        // "Zujj al Nushshabah [38] (5/10)"

        try {
            // Find the boundary markers
            const bracketStart = text.indexOf('[');
            const bracketEnd = text.indexOf(']');
            const parenStart = text.lastIndexOf('(');
            const parenEnd = text.lastIndexOf(')');

            // Ensure all markers exist and are in a logical order before parsing
            if (bracketStart !== -1 && bracketEnd !== -1 && parenStart !== -1 && parenEnd !== -1 && bracketStart < parenStart) {
                
                // 1. Extract the name (everything before the first '[')
                const namePart = text.substring(0, bracketStart).trim();

                // 2. Extract the coordinates (everything inside the last '()')
                const coordString = text.substring(parenStart + 1, parenEnd);
                const coords = coordString.split('/');

                if (coords.length === 2 && namePart) {
                    systems.push({
                        id: id,
                        name: namePart,
                        x: parseInt(coords[0], 10),
                        y: parseInt(coords[1], 10)
                    });
                }
            }
        } catch (err) {
            console.warn(`[Spy] Failed to parse system string: "${text}"`, err);
        }
    });

    if (systems.length === 0) {
        console.warn("[Spy] Dropdown found, but no systems parsed. Check HTML structure.");
        return;
    }

    try {
        const response = await fetch('/hub-api/sync/galaxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systems })
        });
        
        if (response.ok) {
            console.log(`[Spy] Galaxy master index synced! (${systems.length} systems mapped)`);
        }
    } catch (err) {
        console.error(`[Spy] Galaxy API request failed`, err);
    }
}