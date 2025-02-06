const express = require('express');
const { OBSWebSocket } = require('obs-websocket-js');
const readline = require('readline');
const path = require('path');
const Service = require('node-windows').Service;

const obs = new OBSWebSocket();
const app = express();
const PORT = 4085;
const OBS_HOST = '127.0.0.1';
const OBS_PORT = '4455';
const OBS_PASSWORD = '123456';

let obsConnected = false;

var svc = new Service({
    name:'OBS WS Manager',
    description: 'Control OBS from Browser',
    script: 'D:\\OBS\\NodeOBS\\server.js',
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

// Créer l'interface readline pour lire les commandes du terminal
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

app.use(express.static(path.join(__dirname, 'public')));

// Connexion à OBS
async function connectOBS() {
    try {
        await obs.connect('ws://' + OBS_HOST + ':' + OBS_PORT, OBS_PASSWORD);
        console.log('✅ Connecté à OBS WebSocket');
		obsConnected = true;
    } catch (error) {
        console.log('❌ Erreur de connexion OBS:', error);
    }
}

// Fonction pour vérifier la connexion à OBS
async function checkObsConnection() {
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

// Récupérer la liste des scènes
app.get('/scenes', async (req, res) => {
    try {
        const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
        res.json({ scenes: scenes.map(scene => scene.sceneName), activeScene: currentProgramSceneName });
    } catch (error) {
        res.status(500).json({ error: 'Impossible de récupérer les scènes' });
    }
});

// Changer de scène et récupérer ses sources
app.get('/change-scene/:scene', async (req, res) => {
    const sceneName = req.params.scene;
    try {
        await obs.call('SetCurrentProgramScene', { sceneName });

        const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
        const sources = sceneItems.map(item => ({
            name: item.sourceName,
            active: item.sceneItemEnabled
        }));

        res.json({ success: true, sources });
    } catch (error) {
        res.status(500).json({ error: 'Impossible de changer de scène' });
    }
});

// Activer/Désactiver une source
app.get('/toggle-source/:scene/:source', async (req, res) => {
    const { scene, source } = req.params;
    try {
        // Récupérer la liste des sources pour trouver l'ID de la source
        const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
        const sceneItem = sceneItems.find(item => item.sourceName === source);

        if (!sceneItem) {
            throw new Error(`Source "${source}" introuvable dans la scène "${scene}"`);
        }

        // Récupérer l'état actuel de la source
        const { sceneItemEnabled } = await obs.call('GetSceneItemEnabled', {
            sceneName: scene,
            sceneItemId: sceneItem.sceneItemId
        });

        // Inverser l'état de la source
        await obs.call('SetSceneItemEnabled', {
            sceneName: scene,
            sceneItemId: sceneItem.sceneItemId,
            sceneItemEnabled: !sceneItemEnabled
        });

        res.json({ success: true, source, active: !sceneItemEnabled });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Changement de texte Dynamique
app.get('/change-text/:source/:newText', async (req, res) => {
    const { source, newText } = req.params;
    try {
        // Changer le texte de la source
        await obs.call('SetInputSettings', {
            inputName: source, // Nom de la source
            inputSettings: {
				text: newText,
			}
        });

        res.json({ message: 'Texte changé avec succès.' });
    } catch (error) {
        console.error('❌ Erreur lors du changement de texte:', error);
        res.status(500).json({ error: 'Impossible de changer le texte de la source.' });
    }
});

// Récupération de texte Dynamique
app.get('/get-text/:source', async (req, res) => {
    const { source } = req.params;
    
    try {
        // Récupérer les paramètres de la source
        const { inputSettings } = await obs.call('GetInputSettings', { inputName: source });
        
        // Vérifier si la source contient un champ 'text'
        if (inputSettings && inputSettings.text) {
            // Retourner le texte actuel
            res.json({ text: inputSettings.text });
        } else {
            // Si le texte n'est pas trouvé dans les paramètres
            res.status(404).json({ error: 'Le texte de la source n\'a pas été trouvé.' });
        }
    } catch (error) {
        console.error('❌ Erreur lors de la récupération du texte:', error);
        res.status(500).json({ error: 'Impossible de récupérer le texte de la source.' });
    }
});

// Récupération de la position sur un media
app.get('/media-status', async (req, res) => {
    //try {
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
            return res.json({ error: 'Aucun média détecté dans la scène active.' });
        }

        // Récupérer les infos du média
        const { mediaState, mediaDuration, mediaCursor } = await obs.call('GetMediaInputStatus', {
            inputName: mediaSource
        });

        res.json({
            sourceName: mediaSource,
            state: mediaState, // playing, paused, stopped
            currentTime: mediaCursor || 0, // Temps actuel (si non défini, mettre à 0)
            totalTime: mediaDuration // Durée totale
        });
    /*} catch (error) {
        res.status(500).json({ error: 'Impossible de récupérer le statut du média.' });
    }*/
});

// Fonction qui s'exécute lorsque l'utilisateur tape "debug"
rl.on('line', async (input) => {
    if (input.trim().toLowerCase() === 'debug') {
        console.log("🔧 Commande 'debug' détectée. Exécution du débogage...");
        try {
            // Récupérer la scène active
            const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');

            // Récupérer toutes les sources de la scène active
            const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });

            console.log(`📢 Scène active: ${currentProgramSceneName}`);
            console.log('📌 Sources détectées :', sceneItems.map(item => item.sourceName));

            for (const item of sceneItems) {
                try {
                    // Vérifier si la source est un "ffmpeg_source"
                    const { inputKind } = await obs.call('GetInputSettings', { inputName: item.sourceName });

                    console.log(`🔍 Source : ${item.sourceName} | Type : ${inputKind}`);
                } catch (err) {
                    console.warn(`⚠️ Impossible de récupérer les infos de ${item.sourceName}`);
                }
            }
        } catch (error) {
            console.error('❌ Erreur serveur:', error);
        }
    }else if (input.trim().toLowerCase() === 'exit') {
		gracefulShutdown();
	}
});

// Fonction pour fermer proprement le serveur et OBS
function gracefulShutdown() {
    console.log("🛑 Fermeture en cours...");

	// Supprimer les Timers
	clearInterval(varcheckOBS);
	varcheckOBS = null;
	
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

// Lors de la reconnexion à OBS, on peut réinitialiser certaines variables ou informer l'utilisateur
obs.on('Open', () => {
    console.log("🔌 Connexion à OBS établie !");
    obsConnected = true;
});

// En cas de déconnexion, on réinitialise l'état
obs.on('Close', () => {
    console.error("❌ Perte de connexion avec OBS.");
    obsConnected = false;
});

// Lancer le serveur
const server = app.listen(PORT, async () => {
    console.log(`🚀 Serveur sur http://localhost:${PORT}`);
    await connectOBS();
});

// Vérifier la connexion toutes les 5 secondes
let varcheckOBS = setInterval(checkObsConnection, 5000);  // 5000ms = 5 secondes

// Gérer les signaux d'arrêt (Ctrl+C)
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

svc.on('stop', gracefulShutdown);
process.on('message', m => { if(m == 'shutdown'){ gracefulShutdown(); } });