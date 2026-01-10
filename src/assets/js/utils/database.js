/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { NodeBDD, DataType } = require('node-bdd');
const nodedatabase = new NodeBDD();
const { ipcRenderer } = require('electron');
const fs = require('fs'); // <--- AJOUT IMPORTANT

let dev = process.env.NODE_ENV === 'dev';

class database {
    async creatDatabase(tableName, tableConfig) {
        // --- CORRECTION : Calcul du chemin et création du dossier ---
        let dataPath = await ipcRenderer.invoke('path-user-data');
        let dbFolder = dev ? '../..' : '/databases';
        let fullPath = `${dataPath}${dbFolder}`;

        // Si on est en prod et que le dossier n'existe pas, on le crée
        if (!dev && !fs.existsSync(fullPath)) {
            try {
                fs.mkdirSync(fullPath, { recursive: true });
            } catch (err) {
                console.error("Impossible de créer le dossier database:", err);
            }
        }
        // -----------------------------------------------------------

        return await nodedatabase.intilize({
            databaseName: 'Databases',
            fileType: dev ? 'sqlite' : 'db',
            tableName: tableName,
            path: fullPath,
            tableColumns: tableConfig,
        });
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