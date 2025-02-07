//🛑📢📌🔍⚠️❌✅
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { OBSWebSocket } = require('obs-websocket-js');
const path = require('path');
const Service = require('node-windows').Service;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const obs = new OBSWebSocket();
const PORT = 4085;

const OBS_HOST = '127.0.0.1';
const OBS_PORT = '4455';
const OBS_PASSWORD = '123456';

let checkOBSInterval = null;
let statusInterval = null;

let obsConnected = false;

var svc = new Service({
    name:'OBS Web Manager',
    description: 'Control OBS from your Browser',
    script: path.join(__dirname, 'server.js'),
    stopparentfirst: true
});

var args = process.argv.slice(2);
if(args.includes('install')){
    svc.on('install',function(){
        svc.start();
        setInterval(process.exit, 1500);
    });      
    svc.install();
	return;
}else if(args.includes('uninstall')){
    svc.on('uninstall',function(){
        process.exit();
    });      
    svc.uninstall();
	return;
}

app.use(express.static(path.join(__dirname, 'public')));

// Connexion à OBS
async function connectOBS() {
    try {
        await obs.connect('ws://' + OBS_HOST + ':' + OBS_PORT, OBS_PASSWORD);
        console.log('✅ Connecté à OBS WebSocket');
        
        obsConnected = true;
        
        // Dès que la connexion est établie, envoyer les données nécessaires
        sendScenes();
        sendSources();
        sendStreamStatus();
        sendMediaStatus();

        // Si la reconnexion a réussi, arrêter l'intervalle
        if (!statusInterval) {
            clearInterval(statusInterval);
        }
        statusInterval = setInterval(sendAllStatus, 500);
    } catch (err) {
        obsConnected = false;
        console.error('⚠️Erreur de connexion OBS:', err);
        if (!statusInterval) {
            clearInterval(statusInterval);
            statusInterval = null;
        }
        broadcast({ type: 'reconnecting' });
    }
}

// Gère les connexions WebSocket
wss.on('connection', (ws) => {
    console.log('📢 Client connecté');
    
    ws.on('message', async (message) => {
        if (!obsConnected) return;

        const data = JSON.parse(message);

        if (data.type === 'changeScene') {
            await obs.call('SetCurrentProgramScene', { sceneName: data.scene });
            sendScenes();
            sendSources();
        }

        if (data.type === 'toggleSource') {
            const { scene, source } = data;
            const sourceInfo = await obs.call('GetSceneItemList', { sceneName: scene });
            const item = sourceInfo.sceneItems.find(item => item.sourceName === source);

            if (item) {
                await obs.call('SetSceneItemEnabled', {
                    sceneName: scene,
                    sceneItemId: item.sceneItemId,
                    sceneItemEnabled: !item.sceneItemEnabled
                });
                sendSources();
            }
        }

        if (data.type === 'toggleStream') {
            const status = await obs.call('GetStreamStatus');
            if (status.outputActive) {
                await obs.call('StopStream');
            } else {
                await obs.call('StartStream');
            }
            sendStreamStatus();
        }

        if (data.type === 'changeTextCounter') {
            try {
                await obs.call('SetInputSettings', {
                    inputName: 'TXTTHCounter',
                    inputSettings: {
                        text: data.newText,
                    }
                });
            } catch (error) {
                console.error('❌ Erreur lors du changement de texte:', error);
            }
            sendTextCounter();
        }
    });

    if (obsConnected) {
        sendScenes();
        sendSources();
        sendStreamStatus();
        sendMediaStatus();
        sendTextCounter();
    } else {
        broadcast({ type: 'reconnecting', message: 'Tentative de reconnexion à OBS...' });
    }
});

// Connexion WebSocket OBS + Envoi des mises à jour en temps réel
obs.on('Event', async (event) => {
    console.log('📢' + event);
    if (event.eventType === 'CurrentProgramSceneChanged') {
        sendScenes(); // Mise à jour des scènes
        sendSources(); // Mise à jour des sources
    }
    
    if (event.eventType === 'StreamStateChanged') {
        sendStreamStatus(); // Mise à jour du statut du live
    }

    if (event.eventType === 'MediaInputPlaybackEnded' || event.eventType === 'MediaInputPlaybackStarted') {
        sendMediaStatus(); // Mise à jour du statut média
    }
});

function sendAllStatus(){
    if (!obsConnected) return;
    sendStreamStatus();
    sendMediaStatus();
}

// Envoi des scènes en temps réel
async function sendScenes() {
    try {
        const scenes = await obs.call('GetSceneList');
        const activeScene = await obs.call('GetCurrentProgramScene');

        broadcast({ type: 'scenes', scenes: scenes.scenes.map(s => s.sceneName), activeScene: activeScene.currentProgramSceneName });
    } catch (err) {
        console.error('⚠️ Erreur de connexion OBS:', err);
    }
}

// Envoie les sources de la scène active
async function sendSources() {
    try {
        const activeScene = await obs.call('GetCurrentProgramScene');
        const sceneItems = await obs.call('GetSceneItemList', { sceneName: activeScene.currentProgramSceneName });
    
        broadcast({ type: 'sources', scene: activeScene.currentProgramSceneName, sources: sceneItems.sceneItems });
    } catch (err) {
        console.error('⚠️ Erreur de connexion OBS:', err);
    }
}

// Envoie l'état du stream
async function sendStreamStatus() {
    try {
        const status = await obs.call('GetStreamStatus');
        broadcast({ type: 'streamStatus', isStreaming: status.outputActive });
    } catch (err) {
        console.error('⚠️ Erreur de connexion OBS:', err);
    }
}

// Envoie l'état du média en cours
async function sendMediaStatus() {
    try {
        // Récupérer la scène active
        const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');

        // Récupérer toutes les sources de la scène active
        const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });

        let mediaSource = null;

        for (const item of sceneItems) {
            try {
                // Vérifier si la source est un "ffmpeg_source"
                const { inputKind } = await obs.call('GetInputSettings', { inputName: item.sourceName });

                if (inputKind && inputKind === 'ffmpeg_source') {
                    mediaSource = item.sourceName;
                    break; // On prend le premier média trouvé de type ffmpeg
                }
            } catch (err) {
            }
        }

        if (!mediaSource) {
            broadcast({
                type: 'mediaStatus',
                error: 'NO_MEDIA'
            });
            return;
        }

        const { mediaState, mediaDuration, mediaCursor } = await obs.call('GetMediaInputStatus', {
            inputName: mediaSource
        });

        broadcast({
            type: 'mediaStatus',
            state: mediaState,
            sourceName: mediaSource,
            currentTime: mediaCursor,
            totalTime: mediaDuration
        });
    } catch (error) {
        console.error("⚠️ Erreur lors de la récupération du média:", error);
        broadcast({
            type: 'mediaStatus',
            error: "Erreur lors de la récupération du média.",
            sourceName: null,
            currentTime: null,
            totalTime: null
        });
    }
}

// Envoie le numéro de Counter
async function sendTextCounter() {
    try {
        const { inputSettings } = await obs.call('GetInputSettings', { inputName: 'TXTTHCounter' });
        if (inputSettings && inputSettings.text) {
            broadcast({
                type: 'textCounter',
                text: inputSettings.text
            });
        }
    } catch (error) {
        console.error("❌ " + error);
    }
}

// Fonction pour vérifier la connexion à OBS
async function checkObsConnection() {
    if (!obsConnected){
        return connectOBS();
    }
    try {
        // Effectuer une requête basique pour vérifier si OBS est connecté
        const response = await obs.call('GetVersion');
        
        // Si la requête réussit, OBS est bien connecté
        if (response) {
            if (!obsConnected) {
                console.log("✅ Connexion à OBS rétablie.");
                obsConnected = true;
            }
        }
    } catch (error) {
        if (obsConnected) {
            console.error("❌ La connexion à OBS a été perdue. Tentative de reconnexion...");
            obsConnected = false;
        } else {
			connectOBS();
		}
    }
}

checkOBSInterval = setInterval(checkObsConnection, 5000); 

// Fonction de broadcast à tous les clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

server.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
    connectOBS();
});

// Fonction pour fermer proprement le serveur et OBS
function gracefulShutdown() {
    console.log("🛑 Fermeture en cours...");

	// Supprimer les Timers
	clearInterval(checkOBSInterval);
	checkOBSInterval = null;

    clearInterval(statusInterval);
    statusInterval = null;
	
    // Fermer la connexion OBS
    obs.disconnect().then(() => {
        console.log("✅ Déconnecté d'OBS.");
    }).catch((err) => {
        console.error("❌ Impossible de fermer la connexion à OBS:", err);
    });

    // Arrêter le serveur HTTP
    server.close(() => {
        console.log("✅ Serveur HTTP fermé.");
        process.exit(0);  // Quitter le processus Node.js
    });

    // Si le serveur ne se ferme pas dans un délai raisonnable, forcer la fermeture
    setTimeout(() => {
        console.error("❌ Le serveur n'a pas pu être fermé proprement dans les délais.");
        process.exit(1);
    }, 5000);  // Attente de 5 secondes avant de forcer la fermeture
}

// Gérer les signaux d'arrêt (Ctrl+C)
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

svc.on('stop', gracefulShutdown);
process.on('message', m => { if(m == 'shutdown'){ gracefulShutdown(); } })