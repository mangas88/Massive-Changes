const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs'); // Aggiunto per leggere il file servers.json

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Carica la configurazione dei server dal file JSON
// Assicurati di creare il file servers.json nella stessa cartella del server.js!
let serversConfig = {};
try {
    serversConfig = JSON.parse(fs.readFileSync('servers.json', 'utf8'));
} catch (err) {
    console.error("ATTENZIONE: File servers.json non trovato o formato non valido. Crealo prima di avviare il server.");
}

// Funzione Helper Dinamica: ora richiede il serverId per pescare l'URL e la Chiave giusti
async function pbxwareRequest(serverId, action, params = {}) {
    if (!serverId || !serversConfig[serverId]) {
        throw new Error("Server non valido o non selezionato.");
    }
    
    const server = serversConfig[serverId];
    try {
        const queryParams = new URLSearchParams({ apikey: server.apikey, action: action, ...params });
        const response = await axios.get(`${server.url}/?${queryParams.toString()}`);
        if (response.data.error) throw new Error(response.data.error);
        return response.data;
    } catch (error) {
        throw error;
    }
}

// Nuova rotta: Invia la lista dei server al frontend (nascondendo le API KEY per sicurezza)
app.get('/api/servers', (req, res) => {
    const serverList = Object.keys(serversConfig).map(id => ({
        id: id,
        name: serversConfig[id].name
    }));
    res.json(serverList);
});

// Le rotte GET ora usano req.query.serverId
app.get('/api/tenants', async (req, res) => {
    try { res.json(await pbxwareRequest(req.query.serverId, 'pbxware.tenant.list')); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/extensions/:tenantId', async (req, res) => {
    try { res.json(await pbxwareRequest(req.query.serverId, 'pbxware.ext.list', { server: req.params.tenantId })); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tenant-trunks/:tenantId', async (req, res) => {
    try { res.json(await pbxwareRequest(req.query.serverId, 'pbxware.tenant.trunks.list', { tenant: req.params.tenantId })); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Modifica Massiva Avanzata (La tua logica esatta, aggiunto solo serverId)
app.post('/api/extensions/bulk-update', async (req, res) => {
    const { serverId, tenantId, extensionIds, updateData, esStates, esCallerId } = req.body;

    if (!serverId || !tenantId || !extensionIds) {
        return res.status(400).json({ error: 'Dati mancanti.' });
    }

    const results = { success: [], failed: [] };

    for (const extId of extensionIds) {
        let extErrors = [];
        let successCount = 0;

        // 1. Aggiorna i dati standard dell'interno (Call Control, Auto Prov, Codecs)
        if (updateData && Object.keys(updateData).length > 0) {
            try {
                await pbxwareRequest(serverId, 'pbxware.ext.edit', { server: tenantId, id: extId, ...updateData });
                successCount++;
            } catch (err) {
                extErrors.push(`Errore Dati Base: ${err.message || err}`);
            }
        }

        // 2. Aggiorna lo stato degli Enhanced Services (es: abilita DND, Forwarding, ecc.)
        if (esStates && Object.keys(esStates).length > 0) {
            try {
                // AZIONE CORRETTA: pbxware.ext.es.states.set
                await pbxwareRequest(serverId, 'pbxware.ext.es.states.set', { server: tenantId, id: extId, ...esStates });
                successCount++;
            } catch (err) {
                extErrors.push(`Errore Stati Servizi (ES): ${err.message || err}`);
            }
        }

        // 3. Aggiorna la configurazione specifica del Caller ID e dei Trunk associati
        if (esCallerId && Object.keys(esCallerId).length > 0) {
            try {
                // AZIONE CORRETTA: pbxware.ext.es.callerid.edit
                await pbxwareRequest(serverId, 'pbxware.ext.es.callerid.edit', { server: tenantId, id: extId, ...esCallerId });
                successCount++;
            } catch (err) {
                extErrors.push(`Errore Config CallerID: ${err.message || err}`);
            }
        }

        // Responso finale per questo interno
        if (extErrors.length === 0 && successCount > 0) {
            results.success.push({ id: extId, message: "Tutte le modifiche applicate con successo" });
        } else if (successCount > 0 && extErrors.length > 0) {
            // Modifica parziale: se fallisce una cosa ma un'altra funziona, viene salvato quello che si può.
            results.failed.push({ id: extId, error: "Applicato Parzialmente. Dettagli: " + extErrors.join(" | ") });
        } else {
            // Tutto fallito
            results.failed.push({ id: extId, error: extErrors.join(" | ") });
        }
    }

    res.json(results);
});

// ROTTA 2: Aggiornamento GNR (Diverso per ogni interno)
app.post('/api/extensions/gnr-update', async (req, res) => {
    const { serverId, tenantId, updates } = req.body; // Aggiunto serverId
    if (!serverId || !tenantId || !updates) return res.status(400).json({ error: 'Dati mancanti.' });

    const results = { success: [], failed: [] };
    for (const update of updates) {
        try {
            await pbxwareRequest(serverId, 'pbxware.ext.es.callerid.edit', {
                server: tenantId,
                id: update.extId,
                trunks: update.trunks,
                tcallerids: update.tcallerids,
                tprivacies: update.tprivacies
            });
            results.success.push({ id: update.extId });
        } catch (err) {
            results.failed.push({ id: update.extId, error: err.message });
        }
    }
    res.json(results);
});


// ROTTA 3: Creazione Massiva DID
// ==========================================
// ROTTA 3: Creazione Massiva DID
// ==========================================
app.post('/api/dids/bulk-add', async (req, res) => {
    const { serverId, tenantId, trunkId, didsToCreate } = req.body;
    if (!serverId || !tenantId || !trunkId || !didsToCreate) {
        return res.status(400).json({ error: 'Dati mancanti.' });
    }

    let resolvedTrunkId = trunkId; // Inizialmente è il Nome passato dal frontend

    // PBXware per i DID vuole l'ID numerico. Se abbiamo un testo (il nome), lo traduciamo.
    if (isNaN(trunkId)) {
        try {
            // Chiamiamo la lista di tutti i trunk (server=1 richiesto per i multi-tenant)
            const allTrunks = await pbxwareRequest(serverId, 'pbxware.trunk.list', { server: 1 });
            for (const [id, data] of Object.entries(allTrunks)) {
                if (typeof data === 'object' && data.name === trunkId) {
                    resolvedTrunkId = id; // Trovato l'ID numerico corrispondente!
                    break;
                }
            }
        } catch (err) {
            console.error("Impossibile risolvere l'ID del trunk:", err.message);
        }
    }

    const results = { success: [], failed: [] };
    
    // Iteriamo su ogni DID da creare
    for (const item of didsToCreate) {
        try {
            await pbxwareRequest(serverId, 'pbxware.did.add', {
                server: tenantId,          
                trunk: resolvedTrunkId,      // <--- Ora passiamo l'ID numerico esatto!
                did: item.did,             
                dest_type: '0',              // 0 = Extension
                destination: item.extension, // Numero dell'interno
                disabled: '0'                // 0 = Abilitato di default
            });
            results.success.push({ extension: item.extension, did: item.did });
        } catch (err) {
            results.failed.push({ extension: item.extension, did: item.did, error: err.message });
        }
    }
    
    res.json(results);
});

// ==========================================
// ROTTA PER IL RECUPERO DELLE UAD (Dispositivi)
// ==========================================
app.get('/api/uads/:tenantId', async (req, res) => {
    try {
        // console.log(`\n--- RICHIESTA UAD PER TENANT ${req.params.tenantId} ---`);
        let data = await pbxwareRequest(req.query.serverId, 'pbxware.uad.list', { server: req.params.tenantId });
        
        if (data.error) throw new Error(data.error);

        // STAMPA IN CONSOLE TUTTO QUELLO CHE RICEVE DAL PBXWARE
        // console.log(">>> LISTA UAD RICEVUTA DAL CENTRALINO:");
        // console.log(JSON.stringify(data, null, 2));
        // console.log("---------------------------------------\n");

        res.json(data);
    } catch (err) {
        console.log(`Errore UAD Tenant (${err.message}), tento il fallback sul server=1...`);
        try {
            let fallbackData = await pbxwareRequest(req.query.serverId, 'pbxware.uad.list', { server: 1 });
            
            // console.log(">>> LISTA UAD GLOBALE RICEVUTA:");
            // console.log(JSON.stringify(fallbackData, null, 2));
            // console.log("---------------------------------------\n");
            
            res.json(fallbackData);
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    }
});
// ==========================================
// ROTTA 4: Creazione Massiva Interni
// ==========================================

function generateComplexSecret(length = 16) {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const specials = "%*!_-"; 
    const allChars = upper + lower + numbers + specials;

    let secret = "";
    secret += upper[Math.floor(Math.random() * upper.length)];
    secret += lower[Math.floor(Math.random() * lower.length)];
    secret += numbers[Math.floor(Math.random() * numbers.length)];
    secret += specials[Math.floor(Math.random() * specials.length)];

    for (let i = 4; i < length; i++) {
        secret += allChars[Math.floor(Math.random() * allChars.length)];
    }
    return secret.split('').sort(() => 0.5 - Math.random()).join('');
}

function generateRandomPIN() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

app.post('/api/extensions/bulk-add', async (req, res) => {
    const { serverId, tenantId, extensions, defaults, esDefaults } = req.body;
    if (!serverId || !tenantId || !extensions) return res.status(400).json({ error: 'Dati mancanti.' });

    let cleanUa = '';
    if (defaults.ua) {
        cleanUa = defaults.ua.toString().replace(/[^0-9]/g, '');
    }

    if (!cleanUa) {
        return res.json({ success: [], failed: [{ ext: 'Tutti', error: "Nessun ID Dispositivo (UAD) selezionato." }] });
    }

    const results = { success: [], failed: [] };

    for (const ext of extensions) {
        try {
            const autoSecret = generateComplexSecret(16);
            const autoPin = generateRandomPIN();

            const addPayload = {
                server: tenantId,
                ext: ext.number,
                name: ext.name,
                email: ext.email,
                prot: 'sip',
                status: '1',
                secret: autoSecret,
                pin: autoPin,
                ...defaults, 
                ua: cleanUa 
            };

            if (ext.mac && ext.mac.trim() !== '') {
                addPayload.macaddress = ext.mac.replace(/[:\-]/g, '').trim();
            }

            const addRes = await pbxwareRequest(serverId, 'pbxware.ext.add', addPayload);
            const newExtId = addRes.id || ext.number;

            if (esDefaults && Object.keys(esDefaults).length > 0) {
                await pbxwareRequest(serverId, 'pbxware.ext.es.states.set', { 
                    server: tenantId, 
                    id: newExtId, 
                    ...esDefaults 
                });
            }

            results.success.push({ ext: ext.number, name: ext.name });
            
        } catch (err) {
            results.failed.push({ ext: ext.number, error: err.message });
        }
    }
    res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
});