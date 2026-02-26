/* main.js */
const { Plugin, Notice, TFolder, Modal, PluginSettingTab, Setting } = require('obsidian');

// 默认设置
const DEFAULT_SETTINGS = {
    enableCascade: true,         // 是否开启级联删除
    stopFolders: "assets",       // 停止删除的文件夹名称
    enableWarning: true,         // 【默认开启】删除确认提醒
    warningThreshold: 3          // 提醒阈值
};

module.exports = class SmartDeletePlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SmartDeleteSettingTab(this.app, this));
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor, view) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                const linkInfo = this.getLinkUnderCursor(lineText, cursor);

                if (linkInfo) {
                    menu.addItem((item) => {
                        item
                            .setTitle("删除附件 ")
                            .setIcon("trash")
                            .onClick(async () => {
                                await this.processDeleteRequest(editor, linkInfo, view.file);
                            });
                    });
                }
            })
        );
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * 处理删除请求的主流程
     */
    async processDeleteRequest(editor, linkInfo, currentNoteFile) {
        
        const { linkText, start, end } = linkInfo;
        const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkText, currentNoteFile.path);

        if (!targetFile) {
            new Notice(`❌ 未找到附件文件: ${linkText}`);
            editor.replaceRange("", { line: start.line, ch: start.ch }, { line: end.line, ch: end.ch });
            return;
        }

        const references = this.getReferences(targetFile);
        if (references.length > 1) {
            editor.replaceRange("", { line: start.line, ch: start.ch }, { line: end.line, ch: end.ch });
            new Notice(`⚠️ 文件被多处引用 (${references.length}处)，仅移除当前链接。\n(保留文件: ${targetFile.name})`);
            return;
        }

        const foldersToDelete = this.calculateCascadeFolders(targetFile);

        const executeDelete = async (deleteFolders = true) => {
            try {
                
                await this.app.vault.trash(targetFile, true);
                new Notice(`已删除附件: ${targetFile.name}`);

                if (deleteFolders && foldersToDelete.length > 0) {
                    for (const folder of foldersToDelete) {
                        const f = this.app.vault.getAbstractFileByPath(folder.path);
                        if (f) await this.app.vault.trash(f, true);
                    }
                    new Notice(`已连带清除 ${foldersToDelete.length} 个空文件夹`);
                }

                editor.replaceRange("", { line: start.line, ch: start.ch }, { line: end.line, ch: end.ch });

            } catch (err) {
                console.error("Delete Error:", err);
                new Notice("删除操作出错，请检查控制台");
            }
        };

        // 决策逻辑
        if (!this.settings.enableCascade || foldersToDelete.length === 0) {
            await executeDelete(false);
            return;
        }

        if (!this.settings.enableWarning) {
            await executeDelete(true);
            return;
        }

        if (foldersToDelete.length < this.settings.warningThreshold) {
            await executeDelete(true);
            return;
        } 
        
        // 级联删除弹窗确认
        new DeleteConfirmModal(this.app, foldersToDelete, async (choice) => {
            if (choice === 'all') {
                await executeDelete(true);
            } else if (choice === 'file_only') {
                await executeDelete(false);
            }
        }).open();
    }

    calculateCascadeFolders(targetFile) {
        if (!this.settings.enableCascade) return [];
        const stopFolderNames = this.settings.stopFolders.split(',').map(s => s.trim()).filter(s => s.length > 0);
        let foldersToDelete = [];
        let currentFolder = targetFile.parent;
        let ignoredPaths = new Set([targetFile.path]);

        while (currentFolder && !currentFolder.isRoot()) {
            if (stopFolderNames.includes(currentFolder.name)) break;
            const children = currentFolder.children.filter(child => {
                const name = child.name;
                const isSystem = name === ".DS_Store" || name === "Thumbs.db" || name === "Desktop.ini";
                const isIgnored = ignoredPaths.has(child.path);
                return !isSystem && !isIgnored;
            });

            if (children.length === 0) {
                foldersToDelete.push(currentFolder);
                ignoredPaths.add(currentFolder.path);
                currentFolder = currentFolder.parent;
            } else {
                break;
            }
        }
        return foldersToDelete;
    }

    getReferences(targetFile) {
        const refs = [];
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const targetPath = targetFile.path;
        for (const mdFile of markdownFiles) {
            const cache = this.app.metadataCache.getFileCache(mdFile);
            if (!cache) continue;
            if (cache.embeds) {
                for (const embed of cache.embeds) {
                    const resolved = this.app.metadataCache.getFirstLinkpathDest(embed.link, mdFile.path);
                    if (resolved && resolved.path === targetPath) refs.push(mdFile);
                }
            }
            if (cache.links) {
                for (const link of cache.links) {
                    const resolved = this.app.metadataCache.getFirstLinkpathDest(link.link, mdFile.path);
                    if (resolved && resolved.path === targetPath) refs.push(mdFile);
                }
            }
        }
        return refs;
    }

    getLinkUnderCursor(lineText, cursor) {
        const wikiRegex = /!?\[\[(.*?)(?:\|.*?)?\]\]/g;
        const mdRegex = /!?\[.*?\]\((.*?)\)/g;
        let match;
        while ((match = wikiRegex.exec(lineText)) !== null) {
            if (cursor.ch >= match.index && cursor.ch <= match.index + match[0].length) {
                return { linkText: match[1], start: { line: cursor.line, ch: match.index }, end: { line: cursor.line, ch: match.index + match[0].length } };
            }
        }
        while ((match = mdRegex.exec(lineText)) !== null) {
            if (cursor.ch >= match.index && cursor.ch <= match.index + match[0].length) {
                return { linkText: decodeURIComponent(match[1]), start: { line: cursor.line, ch: match.index }, end: { line: cursor.line, ch: match.index + match[0].length } };
            }
        }
        return null;
    }
};

class SmartDeleteSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: '附件删除设置' });

        new Setting(containerEl).setName('启用级联删除').setDesc('删除附件后，如果文件夹变为空，则自动删除文件夹。')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.enableCascade).onChange(async (value) => {
                this.plugin.settings.enableCascade = value;
                await this.plugin.saveSettings();
                this.display();
            }));

        if (this.plugin.settings.enableCascade) {
            new Setting(containerEl).setName('停止删除的文件夹名单').setDesc('遇到这些名称的文件夹时停止删除（如 "assets"），空着则不停止。')
                .addText(text => text.setPlaceholder('assets, attachments').setValue(this.plugin.settings.stopFolders).onChange(async (value) => {
                    this.plugin.settings.stopFolders = value;
                    await this.plugin.saveSettings();
                }));

            new Setting(containerEl).setName('开启删除确认提醒').setDesc('默认开启。关闭后，级联删除将静默执行。')
                .addToggle(toggle => toggle.setValue(this.plugin.settings.enableWarning).onChange(async (value) => {
                    this.plugin.settings.enableWarning = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

            if (this.plugin.settings.enableWarning) {
                new Setting(containerEl).setName('提醒触发层数 (阈值)').setDesc('连续删除的文件夹层数达到此数值时，弹出确认框。')
                    .addText(text => text.setPlaceholder('3').setValue(String(this.plugin.settings.warningThreshold)).onChange(async (value) => {
                        let num = parseInt(value);
                        if (isNaN(num) || num < 1) num = 1;
                        this.plugin.settings.warningThreshold = num;
                        await this.plugin.saveSettings();
                    }));
            }
        }
    }
}

class DeleteConfirmModal extends Modal {
    constructor(app, folders, callback) {
        super(app);
        this.folders = folders;
        this.callback = callback;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        contentEl.empty();
        titleEl.empty();

        titleEl.createSpan({
            text: "⚠️", 
            cls: "sd-warning-icon"
        });

        titleEl.createSpan({
            text: "级联删除确认"
        });

        contentEl.createEl("p", {
            text: `删除附件后，将额外删除 ${this.folders.length} 个空文件夹：`
        });

        const listContainer = contentEl.createDiv({
            cls: "sd-list-container"
        });

        const list = listContainer.createEl("ul");
        [...this.folders].reverse().forEach(f => {
            list.createEl("li", {
                text: f.path
            });
        });

        const btnContainer = contentEl.createDiv({
            cls: "sd-btn-row"
        });

        const cancelBtn = btnContainer.createEl("button", {
            text: "取消"
        });
        cancelBtn.onclick = () => {
            this.callback("cancel");
            this.close();
        };

        const fileOnlyBtn = btnContainer.createEl("button", {
            text: "仅删除附件"
        });
        fileOnlyBtn.onclick = () => {
            this.callback("file_only");
            this.close();
        };

        const deleteAllBtn = btnContainer.createEl("button", {
            text: "确认删除",
            cls: "sd-btn-danger"
        });
        deleteAllBtn.onclick = () => {
            this.callback("all");
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}