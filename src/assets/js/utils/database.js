/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { NodeBDD, DataType } = require('node-bdd');
const nodedatabase = new NodeBDD();
const { ipcRenderer } = require('electron');
const fs = require('fs');

let dev = process.env.NODE_ENV === 'dev';

// Cache pour éviter de ré-initialiser la DB 50 fois par seconde
const activeConnections = {};

class database {
    async creatDatabase(tableName, tableConfig) {
        // Si la connexion existe déjà, on la retourne directement
        if (activeConnections[tableName]) {
            return activeConnections[tableName];
        }

        // --- CONFIGURATION DU CHEMIN ---
        let dataPath = await ipcRenderer.invoke('path-user-data');
        // En prod, on s'assure que le dossier databases est bien dans le userData
        let dbFolder = dev ? '../..' : '/databases';
        let fullPath = `${dataPath}${dbFolder}`;

        if (!dev && !fs.existsSync(fullPath)) {
            try {
                fs.mkdirSync(fullPath, { recursive: true });
            } catch (err) {
                console.error("Impossible de créer le dossier database:", err);
            }
        }
        // -------------------------------

        // --- FIX CRITIQUE : Toujours utiliser 'sqlite' ---
        let table = await nodedatabase.intilize({
            databaseName: 'Databases',
            fileType: 'sqlite', // <--- FORCEZ CECI MÊME EN PROD (ne mettez pas 'db')
            tableName: tableName,
            path: fullPath,
            tableColumns: tableConfig,
        });

        // On sauvegarde la connexion pour la réutiliser
        activeConnections[tableName] = table;
        return table;
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