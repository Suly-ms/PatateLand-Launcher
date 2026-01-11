/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { NodeBDD, DataType } = require('node-bdd');
const nodedatabase = new NodeBDD();
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let dev = process.env.NODE_ENV === 'dev';
let dbInstance = null; // Variable pour garder la connexion ouverte

class database {
    async creatDatabase(tableName, tableConfig) {
        // 1. Si la connexion est déjà active, on ne touche à rien (évite de ré-ouvrir)
        if (dbInstance) return dbInstance;

        // --- CALCUL DU CHEMIN ---
        let dataPath = await ipcRenderer.invoke('path-user-data');
        let dbFolder = dev ? '../..' : 'databases';
        // Utilisation de path.join pour un chemin correct sous Windows
        let fullPath = dev ? path.resolve(dataPath, dbFolder) : path.join(dataPath, dbFolder);

        // 2. On s'assure que le DOSSIER existe
        if (!fs.existsSync(fullPath)) {
            try {
                fs.mkdirSync(fullPath, { recursive: true });
            } catch (err) {
                console.error("Erreur création dossier:", err);
            }
        }

        // 3. INITIALISATION SÉCURISÉE
        // Le mode 'sqlite' vérifie automatiquement si le fichier existe.
        // - S'il existe : il se connecte sans rien effacer.
        // - S'il n'existe pas : il le crée.
        // C'est le mode 'db' (JSON) qui causait l'effacement.
        dbInstance = await nodedatabase.intilize({
            databaseName: 'Databases',
            fileType: 'sqlite', // <--- FORCEZ CECI (C'est la clé pour ne pas écraser)
            tableName: tableName,
            path: fullPath,
            tableColumns: tableConfig,
        });

        return dbInstance;
    }

    async getDatabase(tableName) {
        return await this.creatDatabase(tableName, {
            json_data: DataType.TEXT.TEXT,
        });
    }

    async createData(tableName, data) {
        let table = await this.getDatabase(tableName);
        data = await nodedatabase.createData(table, { json_data: JSON.stringify(data) })
        let id = data.id
        data = JSON.parse(data.json_data)
        data.ID = id
        return data
    }

    async readData(tableName, key = 1) {
        let table = await this.getDatabase(tableName);
        let data = await nodedatabase.getDataById(table, key)
        if (data) {
            let id = data.id
            data = JSON.parse(data.json_data)
            data.ID = id
        }
        return data ? data : undefined
    }

    async readAllData(tableName) {
        let table = await this.getDatabase(tableName);
        let data = await nodedatabase.getAllData(table)
        if (!data) return [];
        return data.map(info => {
            let id = info.id
            info = JSON.parse(info.json_data)
            info.ID = id
            return info
        })
    }

    async updateData(tableName, data, key = 1) {
        let table = await this.getDatabase(tableName);
        await nodedatabase.updateData(table, { json_data: JSON.stringify(data) }, key)
    }

    async deleteData(tableName, key = 1) {
        let table = await this.getDatabase(tableName);
        await nodedatabase.deleteData(table, key)
    }
}

export default database;