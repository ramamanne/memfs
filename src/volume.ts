import {resolve, normalize, sep, relative, dirname} from 'path';
import {Node, Link, File, Stats} from "./node";
import {Buffer} from 'buffer';
import setImmediate from './setImmediate';
import process from './process';
const extend = require('fast-extend');
const errors = require('./internal/errors');



// ---------------------------------------- Types

// Node-style errors with a `code` property.
interface IError extends Error {
    code?: string,
}

export type TFilePath = string | Buffer | URL;
export type TFileId = TFilePath | number;           // Number is used as a file descriptor.
export type TDataOut = string | Buffer;             // Data formats we give back to users.
export type TData = TDataOut | Uint8Array;          // Data formats users can give us.
export type TFlags = string | number;
export type TMode = string | number;                // Mode can be a String, although docs say it should be a Number.
export type TEncoding = 'ascii' | 'utf8' | 'utf16le' | 'ucs2' | 'base64' | 'latin1' | 'binary' | 'hex';
export type TEncodingExtended = TEncoding | 'buffer';
export type TCallback<TData> = (error?: IError, data?: TData) => void;



// ---------------------------------------- Constants

import {constants} from "./constants";
const {O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_NOCTTY, O_TRUNC, O_APPEND,
    O_DIRECTORY, O_NOATIME, O_NOFOLLOW, O_SYNC, O_DIRECT, O_NONBLOCK,
    F_OK, R_OK, W_OK, X_OK} = constants;

const ENCODING_UTF8: TEncoding = 'utf8';

// Default modes for opening files.
const enum MODE {
    FILE = 0o666,
    DIR  = 0o777,
    DEFAULT = MODE.FILE,
}



// ---------------------------------------- Error messages

// TODO: Use `internal/errors.js` in the future.

const ERRSTR = {
    PATH_STR:       'path must be a string or Buffer',
    FD:             'file descriptor must be a unsigned 32-bit integer',
    MODE_INT:       'mode must be an int',
    CB:             'callback must be a function',
    UID:            'uid must be an unsigned int',
    GID:            'gid must be an unsigned int',
    LEN:            'len must be an integer',
    ATIME:          'atime must be an integer',
    MTIME:          'mtime must be an integer',
    PREFIX:         'filename prefix is required',
    BUFFER:         'buffer must be an instance of Buffer or StaticBuffer',
    OFFSET:         'offset must be an integer',
    LENGTH:         'length must be an integer',
    POSITION:       'position must be an integer',
};
const ERRSTR_OPTS = tipeof => `Expected options to be either an object or a string, but got ${tipeof} instead`;
// const ERRSTR_FLAG = flag => `Unknown file open flag: ${flag}`;


function formatError(errorCode: string, func = '', path = '', path2 = '') {

    let pathFormatted = '';
    if(path) pathFormatted = ` '${path}'`;
    if(path2) pathFormatted += ` -> '${path2}'`;

    switch(errorCode) {
        case 'ENOENT':      return `ENOENT: no such file or directory, ${func}${pathFormatted}`;
        case 'EBADF':       return `EBADF: bad file descriptor, ${func}${pathFormatted}`;
        case 'EINVAL':      return `EINVAL: invalid argument, ${func}${pathFormatted}`;
        case 'EPERM':       return `EPERM: operation not permitted, ${func}${pathFormatted}`;
        case 'EPROTO':      return `EPROTO: protocol error, ${func}${pathFormatted}`;
        case 'EEXIST':      return `EEXIST: file already exists, ${func}${pathFormatted}`;

        // TODO: These error messages to be implemented:
        // Too many file descriptors open.
        case 'EMFILE':      return 'Too many open files';

        case 'EACCES':      // Access to file forbidden.
        case 'EISDIR':      // When performing file operation on a directory.
        case 'ENOTDIR':     // When trying to do directory operation on not a directory.
        case 'ENOTEMPTY':   // Directory not empty.
        default:            return `Error occurred in ${func}`;
    }
}

function createError(errorCode: string, func = '', path = '', path2 = '', Constructor = Error) {
    const error = new Constructor(formatError(errorCode, func, path, path2));
    (error as any).code = errorCode;
    return error;
}

function throwError(errorCode: string, func = '', path = '', path2 = '', Constructor = Error) {
    throw createError(errorCode, func, path, path2, Constructor);
}


// ---------------------------------------- File identifier checking

function pathOrError(path: TFilePath, encoding?: TEncoding): string | TypeError {
    if(Buffer.isBuffer(path)) path = (path as Buffer).toString(encoding);
    if(typeof path !== 'string') return TypeError(ERRSTR.PATH_STR);
    return path as string;
}

function validPathOrThrow(path: TFilePath, encoding?): string {
    const p = pathOrError(path, encoding);
    if(p instanceof TypeError) throw p;
    else return p as string;
}

function assertFd(fd: number) {
    if(typeof fd !== 'number') throw TypeError(ERRSTR.FD);
}



// ---------------------------------------- Flags

// List of file `flags` as defined by Node.
export enum FLAGS {
    // Open file for reading. An exception occurs if the file does not exist.
    r       = O_RDONLY,
    // Open file for reading and writing. An exception occurs if the file does not exist.
    'r+'    = O_RDWR,
    // Open file for reading in synchronous mode. Instructs the operating system to bypass the local file system cache.
    rs      = O_RDONLY | O_SYNC,
    sr      = FLAGS.rs,
    // Open file for reading and writing, telling the OS to open it synchronously. See notes for 'rs' about using this with caution.
    'rs+'   = O_RDWR | O_SYNC,
    'sr+'   = FLAGS['rs+'],
    // Open file for writing. The file is created (if it does not exist) or truncated (if it exists).
    w       = O_WRONLY | O_CREAT | O_TRUNC,
    // Like 'w' but fails if path exists.
    wx      = O_WRONLY | O_CREAT | O_TRUNC | O_EXCL,
    xw      = FLAGS.wx,
    // Open file for reading and writing. The file is created (if it does not exist) or truncated (if it exists).
    'w+'    = O_RDWR | O_CREAT | O_TRUNC,
    // Like 'w+' but fails if path exists.
    'wx+'   = O_RDWR | O_CREAT | O_TRUNC | O_EXCL,
    'xw+'   = FLAGS['wx+'],
    // Open file for appending. The file is created if it does not exist.
    a       = O_WRONLY | O_APPEND | O_CREAT,
    // Like 'a' but fails if path exists.
    ax      = O_WRONLY | O_APPEND | O_CREAT | O_EXCL,
    xa      = FLAGS.ax,
    // Open file for reading and appending. The file is created if it does not exist.
    'a+'    = O_RDWR | O_APPEND | O_CREAT,
    // Like 'a+' but fails if path exists.
    'ax+'   = O_RDWR | O_APPEND | O_CREAT | O_EXCL,
    'xa+'   = FLAGS['ax+'],
}

export function flagsToNumber(flags: TFlags): number {
    if(typeof flags === 'number') return flags;

    if(typeof flags === 'string') {
        const flagsNum = FLAGS[flags];
        if(typeof flagsNum !== 'undefined') return flagsNum;
    }

    // throw new TypeError(formatError(ERRSTR_FLAG(flags)));
    throw new errors.TypeError('ERR_INVALID_OPT_VALUE', 'flags', flags);
}




// ---------------------------------------- Options

function assertEncoding(encoding: string) {
    if(encoding && !Buffer.isEncoding(encoding))
        throw Error('Unknown encoding: ' + encoding);
}

function getOptions <T> (defaults: T, options?: T|string): T {
    if(!options) return defaults;
    else {
        var tipeof = typeof options;
        switch(tipeof) {
            case 'string': return extend({}, defaults, {encoding: options as string});
            case 'object': return extend({}, defaults, options);
            default: throw TypeError(ERRSTR_OPTS(tipeof));
        }
    }
}

function optsGenerator<TOpts>(defaults: TOpts): (opts) => TOpts {
    return options => getOptions(defaults, options);
}

function validateCallback(callback) {
    if(typeof callback !== 'function')
        throw TypeError(ERRSTR.CB);
    return callback;
}

const optionAndCallbackGenerator = getOpts =>
    (options, callback?) => typeof options === 'function'
        ? [getOpts(), options]
        : [getOpts(options), validateCallback(callback)];

// General options with optional `encoding` property that most commands accept.
export interface IOptions {
    encoding?: TEncoding;
}

export interface IFileOptions extends IOptions {
    mode?: TMode;
    flag?: TFlags;
}

const optsDefaults: IOptions = {
    encoding: 'utf8',
};


// Options for `fs.readFile` and `fs.readFileSync`.
export interface IReadFileOptions extends IOptions {
    flag?: string;
}
const readFileOptsDefaults: IReadFileOptions = {
    flag: 'r',
};
const getReadFileOptions = optsGenerator<IReadFileOptions>(readFileOptsDefaults);


// Options for `fs.writeFile` and `fs.writeFileSync`
export interface IWriteFileOptions extends IFileOptions {}
const writeFileDefaults: IWriteFileOptions = {
    encoding: 'utf8',
    mode: MODE.DEFAULT,
    flag: FLAGS[FLAGS.w],
};
const getWriteFileOptions = optsGenerator<IWriteFileOptions>(writeFileDefaults);


// Options for `fs.realpath` and `fs.realpathSync`
export interface IRealpathOptions {
    encoding?: TEncodingExtended,
}
const realpathDefaults: IReadFileOptions = optsDefaults;
const getRealpathOptions = optsGenerator<IRealpathOptions>(realpathDefaults);


// ---------------------------------------- Utility functions

export function pathToFilename(path: TFilePath): string {

    // TODO: Add support for the new URL object.

    if((typeof path !== 'string') && !Buffer.isBuffer(path))
        throw new TypeError(ERRSTR.PATH_STR);

    const pathString = String(path);
    nullCheck(pathString);
    return pathString;
}

export function filenameToSteps(filename: string): string[] {
    const fullPath = resolve(filename);
    const fulPathSansSlash = fullPath.substr(1);
    return fulPathSansSlash.split(sep);
}

export function pathToSteps(path: TFilePath): string[] {
    return filenameToSteps(pathToFilename(path));
}

export function dataToStr(data: TData, encoding: string = ENCODING_UTF8) {
    if(Buffer.isBuffer(data)) return data.toString(encoding);
    else if(data instanceof Uint8Array) (new Buffer(data)).toString(encoding);
    else return String(data);
}

export function strToEncoding(str: string, encoding?: TEncodingExtended): string | Buffer {
    if(encoding === ENCODING_UTF8) return str;                              // UTF-8
    if(!encoding || (encoding === 'buffer')) return new Buffer(str);        // No encoding or `buffer` encoding
    return (new Buffer(str)).toString(encoding);                            // Custom encoding
}

export function bufferToEncoding(buffer: Buffer, encoding?: TEncodingExtended): string | Buffer {
    if(!encoding || (encoding === 'buffer')) return buffer;
    else return buffer.toString(encoding);
}

// function flagsToFlagsValue(f: string|number): number {
//     if(typeof f === 'number') return f;
//     if(typeof f !== 'string') throw TypeError(`flags must be string or number`);
//     var flagsval = flags[f] as any as number;
//     if(typeof flagsval !== 'number') throw TypeError(`Invalid flags string value '${f}'`);
//     return flagsval;
// }

function nullCheck(path, callback?) {
    if(('' + path).indexOf('\u0000') !== -1) {
        const er = new Error('Path must be a string without null bytes');
        (er as any).code = 'ENOENT';
        if(typeof callback !== 'function')
            throw er;
        process.nextTick(callback, er);
        return false;
    }
    return true;
}

function _modeToNumber(mode: TMode, def?): number {
    if(typeof mode === 'number') return mode;
    if(typeof mode === 'string') return parseInt(mode, 8);
    if(def) return modeToNumber(def);
    return undefined;
}

function modeToNumber(mode: TMode, def?): number {
    const result = _modeToNumber(mode, def);
    if((typeof result !== 'number') || isNaN(result))
        throw new TypeError(ERRSTR.MODE_INT);
    return result;
}

// ---------------------------------------- Volume

/**
 * `Volume` represents a file system.
 */
export class Volume {

    // I-node number counter.
    static ino: number = 0;

    // Constructor function used to create new nodes.
    // NodeClass: new (...args) => TNode = Node as new (...args) => TNode;

    // Hard link to the root of this volume.
    // root: Node = new (this.NodeClass)(null, '', true);
    root: Link;

    // A mapping for i-node numbers to i-nodes (`Node`);
    inodes: {[ino: number]: Node} = {};

    // List of released i-node number, for reuse.
    releasedInos: number[] = [];

    // A mapping for file descriptors to `File`s.
    fds: {[fd: number]: File} = {};

    // A list of reusable (opened and closed) file descriptors, that should be
    // used first before creating a new file descriptor.
    releasedFds = [];

    // Max number of open files.
    maxFiles = 10000;

    // Current number of open files.
    openFiles = 0;

    constructor() {
        const root = new Link(this, null, '');
        root.setNode(this.createNode(true));

        root.setChild('.', root);
        root.getNode().nlink++;

        root.setChild('..', root);
        root.getNode().nlink++;

        this.root = root;
    }

    createLink(parent: Link, name: string, isDirectory: boolean = false, perm?: number): Link {
        return parent.createChild(name, this.createNode(isDirectory, perm));
    }

    private newInoNumber(): number {
        if(this.releasedInos.length) return this.releasedInos.pop();
        else {
            Volume.ino = (Volume.ino++) % 0xFFFFFFFF;
            return Volume.ino;
        }
    }

    createNode(isDirectory: boolean = false, perm?: number): Node {
        const node = new Node(this.newInoNumber(), perm);
        if(isDirectory) node.setIsDirectory();
        this.inodes[node.ino] = node;
        return node;
    }

    private getNode(ino: number) {
        return this.inodes[ino];
    }

    private deleteNode(node: Node) {
        delete this.inodes[node.ino];
        this.releasedInos.push(node.ino);
    }

    getLink(steps: string[]): Link {
        return this.root.walk(steps);
    }

    // Get the immediate parent directory of the link.
    private getDirLink(steps: string[]): Link {
        return this.root.walk(steps, steps.length - 1);
    }

    // Resolves symbolic links.
    // private resolveSymlinks(node: Node): Node {
    //     while(node && node.isSymlink() && node.symlink) {
    //         const link = this.getLink(node.symlink);
    //         if(!link) return null;
    //         node = link.getNode();
    //     }
    //     return node;
    // }
    resolveSymlinks(link: Link): Link {
        let node: Node = link.getNode();
        while(link && node.isSymlink()) {
            link = this.getLink(node.symlink);
            if(!link) return null;
            node = link.getNode();
        }
        return link;
    }

/*

    private getNodeOrCreateFileNode(steps: string[]): Node {
        const dirNode = this.root.walk(steps, steps.length - 1);
        if(!dirNode) throw Error('Directory not found');

        const filename = steps[steps.length - 1];
        let node = dirNode.getChild(filename);
        if(node) {
            return node;
        } else {
            return dirNode.createChild(filename);
        }
    }

    private getNodeById(id: TFileId) {
        if(typeof id === 'number') {
            const file = this.getFileByFd(id);
            if(!file) throw Error('File nto found');
            return file.node;
        } else if((typeof id === 'string') || (Buffer.isBuffer(id))) {
            return this.getLink(pathToSteps(id));
        }
    }
*/

    private getFileByFd(fd: number): File {
        return this.fds[fd];
    }

    private getNodeByIdOrCreate(id: TFileId, flags: number, perm: number): Node {
        if(typeof id === 'number') {
            const file = this.getFileByFd(id);
            if(!file) throw Error('File nto found');
            return file.node;
        } else {
            const steps = pathToSteps(id as TFilePath);
            let link: Link = this.getLink(steps);
            if(link) return link.getNode();

            // Try creating a node if not found.
            if(flags & O_CREAT) {
                const dirLink = this.getDirLink(steps);
                if(dirLink) {
                    const name = steps[steps.length - 1];
                    link = this.createLink(dirLink, name, false, perm);
                    return link.getNode();
                }
            }

            throwError('ENOENT', 'getNodeByIdOrCreate', pathToFilename(id))
        }
    }

    // private createNode(parent: Node, name: string, isDirectory?: boolean, perm?: number): Node {
    //     const node = parent.createChild(name, isDirectory, perm);
    //     return node;
    // }

    private wrapAsync(method: (...args) => void, args: any[], callback: TCallback<any>) {
        if(typeof callback !== 'function')
            throw Error(ERRSTR.CB);

        setImmediate(() => {
            try {
                callback(null, method.apply(this, args));
            } catch(err) {
                callback(err);
            }
        });
    }

    private openLink(link: Link, flagsNum: number): File {
        if(this.openFiles >= this.maxFiles) { // Too many open files.
            throw createError('EMFILE');
        }

        // Reuse released file descriptors.
        let fd: number;
        if(this.releasedFds.length)
            fd = this.releasedFds.pop();

        // Resolve symlinks.
        const realLink = this.resolveSymlinks(link);
        if(!realLink) throwError('ENOENT', 'open', link.getPath());

        const file = new File(link, realLink.getNode(), flagsNum, fd);
        this.fds[file.fd] = file;
        this.openFiles++;

        if(flagsNum & O_TRUNC) file.truncate();

        return file;
    }

    private openFile(fileName: string, flagsNum: number, modeNum: number): File {
        const steps = filenameToSteps(fileName);
        let link: Link = this.getLink(steps);

        // Try creating a new file, if it does not exist.
        if(!link) {
            const dirLink: Link = this.getDirLink(steps);
            if((flagsNum & O_CREAT) && (typeof modeNum === 'number')) {
                link = this.createLink(dirLink, steps[steps.length - 1], false, modeNum);
            }
        }

        if(link) return this.openLink(link, flagsNum);
    }

    private openBase(fileName: string, flagsNum: number, modeNum: number): number {
        const file = this.openFile(fileName, flagsNum, modeNum);
        if(!file) throw createError('ENOENT', 'open', fileName);
        return file.fd;
    }

    openSync(path: TFilePath, flags: TFlags, mode: TMode = MODE.DEFAULT): number {
        // Validate (1) mode; (2) path; (3) flags - in that order.
        const modeNum = modeToNumber(mode);
        const fileName = pathToFilename(path);
        const flagsNum = flagsToNumber(flags);
        return this.openBase(fileName, flagsNum, modeNum);
    }

    open(path: TFilePath, flags: TFlags, /* ... */                      callback: TCallback<number>);
    open(path: TFilePath, flags: TFlags, mode: TMode,                   callback: TCallback<number>);
    open(path: TFilePath, flags: TFlags, a: TMode|TCallback<number>,    b?: TCallback<number>) {
        let mode: TMode = a as TMode;
        let callback: TCallback<number> = b as TCallback<number>;

        if(typeof a === 'function') {
            mode = MODE.DEFAULT;
            callback = a;
        }

        const modeNum = modeToNumber(mode);
        const fileName = pathToFilename(path);
        const flagsNum = flagsToNumber(flags);

        this.wrapAsync(this.openBase, [fileName, flagsNum, modeNum], callback);
    }

    private closeFile(file: File) {
        if(!this.fds[file.fd]) return;

        this.openFiles--;
        delete this.fds[file.fd];
        this.releasedFds.push(file.fd);
    }

    closeSync(fd: number) {
        const file = this.getFileByFd(fd);
        if(!file) throwError('EBADF', 'close');
        this.closeFile(file);
    }

    close(fd: number, callback: TCallback<void>) {
        this.wrapAsync(this.closeSync, [fd], callback);
    }

    private openFileOrGetById(id: TFileId, flagsNum: number, modeNum?: number): File {
        if(typeof id === 'number') {
            const file = this.fds[id];
            if(!file)
                throw createError('ENOENT');
            return file;
        } else {
            return this.openFile(pathToFilename(id), flagsNum, modeNum);
        }
    }

    private readFileBase(id: TFileId, flagsNum: number, encoding: TEncoding): Buffer | string {
        let result: Buffer | string;
        if(typeof id === 'number') {
            const file = this.getFileByFd(id);
            if(!file) throw createError('ENOENT', 'readFile', String(id));
            result = bufferToEncoding(file.getBuffer(), encoding);
        } else {
            const fileName = pathToFilename(id);
            const file = this.openFile(fileName, flagsNum, 0);
            if(!file) throw createError('ENOENT', 'readFile', String(id));
            result = bufferToEncoding(file.getBuffer(), encoding);
            this.closeFile(file);
        }
        return result;
    }

    readFileSync(file: TFileId, options?: IReadFileOptions|string): TDataOut {
        const opts = getReadFileOptions(options);
        const flagsNum = flagsToNumber(opts.flag);
        return this.readFileBase(file, flagsNum, opts.encoding);
    }

    readFile(id: TFileId, callback: TCallback<TDataOut>);
    readFile(id: TFileId, options: IReadFileOptions|string,                 callback: TCallback<TDataOut>);
    readFile(id: TFileId, a: TCallback<TDataOut>|IReadFileOptions|string,   b?: TCallback<TDataOut>) {
        let options: IReadFileOptions|string = a;
        let callback: TCallback<TData> = b;

        if(typeof options === 'function') {
            callback = options;
            options = readFileOptsDefaults;
        }

        const opts = getReadFileOptions(options);
        const flagsNum = flagsToNumber(opts.flag);
        this.wrapAsync(this.readFileBase, [id, flagsNum, opts.encoding], callback);
    }

    private writeFileBase(id: TFileId, dataStr: string, flagsNum: number, modeNum: number) {
        const node = this.getNodeByIdOrCreate(id, flagsNum, modeNum);
        // if(flagsNum & O_R)
        node.setString(dataStr);
    }

    writeFileSync(id: TFileId, data: TData, options?: IWriteFileOptions) {
        const opts = getWriteFileOptions(options);
        const flagsNum = flagsToNumber(opts.flag);
        const modeNum = modeToNumber(opts.mode);
        const dataStr = dataToStr(data, opts.encoding);
        this.writeFileBase(id, dataStr, flagsNum, modeNum);
    }

    writeFile(id: TFileId, data: TData, callback: TCallback<void>);
    writeFile(id: TFileId, data: TData, options: IWriteFileOptions|string,              callback: TCallback<void>);
    writeFile(id: TFileId, data: TData, a: TCallback<void>|IWriteFileOptions|string,    b?: TCallback<void>) {
        let options: IWriteFileOptions|string = a as IWriteFileOptions;
        let callback: TCallback<void> = b;

        if(typeof a === 'function') {
            options = writeFileDefaults;
            callback = a;
        }

        const opts = getWriteFileOptions(options);
        const flagsNum = flagsToNumber(opts.flag);
        const modeNum = modeToNumber(opts.mode);
        const dataStr = dataToStr(data, opts.encoding);
        this.wrapAsync(this.writeFileBase, [id, dataStr, flagsNum, modeNum], callback);
    }

    private symlinkBase(targetFilename: string, pathFilename: string): Link {
        const pathSteps = filenameToSteps(pathFilename);

        // Check if directory exists, where we about to create a symlink.
        const dirLink = this.getDirLink(pathSteps);
        if(!dirLink) throwError('ENOENT', 'symlink', targetFilename, pathFilename);

        const name = pathSteps[pathSteps.length - 1];

        // Check if new file already exists.
        if(dirLink.getChild(name))
            throwError('EEXIST', 'symlink', targetFilename, pathFilename);

        // Create symlink.
        const symlink: Link = this.createLink(dirLink, name);
        symlink.getNode().makeSymlink(filenameToSteps(targetFilename));
        return symlink;
    }

    // `type` argument works only on Windows.
    symlinkSync(target: TFilePath, path: TFilePath, type?: 'file' | 'dir' | 'junction') {
        const targetFilename = pathToFilename(target);
        const pathFilename = pathToFilename(path);
        this.symlinkBase(targetFilename, pathFilename);
    }

    symlink(target: TFilePath, path: TFilePath, callback: TCallback<void>);
    symlink(target: TFilePath, path: TFilePath, type: 'file' | 'dir' | 'junction',                  callback: TCallback<void>);
    symlink(target: TFilePath, path: TFilePath, a: TCallback<void> | 'file' | 'dir' | 'junction',   b?: TCallback<void>) {
        let type: 'file' | 'dir' | 'junction' = a as 'file' | 'dir' | 'junction';
        let callback: TCallback<void> = b;

        if(typeof type === 'function') {
            type = 'file';
            callback = a as TCallback<void>;
        }

        const targetFilename = pathToFilename(target);
        const pathFilename = pathToFilename(path);
        this.wrapAsync(this.symlinkBase, [targetFilename, pathFilename], callback);
    }

    private realpathBase(filename: string, encoding: TEncodingExtended): TDataOut {
        const steps = filenameToSteps(filename);
        const link: Link = this.getLink(steps);
        // TODO: this check has to be perfomed by `lstat`.
        if(!link) throwError('ENOENT', 'realpath', filename);

        // Resolve symlinks.
        const realLink = this.resolveSymlinks(link);
        if(!realLink) throwError('ENOENT', 'realpath', filename);

        return strToEncoding(realLink.getPath(), encoding);
    }

    realpathSync(path: TFilePath, options?: IRealpathOptions): TDataOut {
        const opts = getRealpathOptions(options);
        const pathFilename = pathToFilename(path);
        return this.realpathBase(pathFilename, opts.encoding);
    }

    realpath(path: TFilePath, callback: TCallback<TDataOut>);
    realpath(path: TFilePath, options: IRealpathOptions | string,                   callback: TCallback<TDataOut>);
    realpath(path: TFilePath, a: TCallback<TDataOut> | IRealpathOptions | string,   b?: TCallback<TDataOut>) {
        let options: IRealpathOptions | string = a;
        let callback: TCallback<TDataOut> = b;

        if(typeof options === 'function') {
            callback = options;
            options = realpathDefaults;
        }

        const opts = getRealpathOptions(options);
        const pathFilename = pathToFilename(path);
        this.wrapAsync(this.realpathBase, [pathFilename, opts.encoding], callback);
    }

    private lstatBase(filename: string): Stats {
        const link: Link = this.getLink(filenameToSteps(filename));
        if(!link) throwError('ENOENT', 'lstat', filename);
        return Stats.build(link.getNode());
    }

    lstatSync(path: TFilePath): Stats {
        return this.lstatBase(pathToFilename(path));
    }

    lstat(path: TFilePath, callback: TCallback<Stats>) {
        this.wrapAsync(this.lstatBase, [pathToFilename(path)], callback);
    }

    private statBase(filename: string): Stats {
        let link: Link = this.getLink(filenameToSteps(filename));
        if(!link) throwError('ENOENT', 'stat', filename);

        // Resolve symlinks.
        link = this.resolveSymlinks(link);
        if(!link) throwError('ENOENT', 'stat', filename);

        return Stats.build(link.getNode());
    }

    statSync(path: TFilePath): Stats {
        return this.statBase(pathToFilename(path));
    }

    stat(path: TFilePath, callback: TCallback<Stats>) {
        this.wrapAsync(this.statBase, [pathToFilename(path)], callback);
    }

    private fstatBase(fd: number): Stats {
        const file = this.getFileByFd(fd);
        if(!file) throwError('EBADF', 'fstat');
        return Stats.build(file.node);
    }

    fstatSync(fd: number): Stats {
        return this.fstatBase(fd);
    }

    fstat(fd: number, callback: TCallback<Stats>) {
        this.wrapAsync(this.fstatBase, [fd], callback);
    }

    private renameBase(oldPathFilename: string, newPathFilename: string) {
        const link: Link = this.getLink(filenameToSteps(oldPathFilename));
        if(!link) throwError('ENOENT', 'rename', oldPathFilename, newPathFilename);

        // TODO: Check if it is directory, if non-empty, we cannot move it, right?

        const newPathSteps = filenameToSteps(newPathFilename);

        // Check directory exists for the new location.
        const newPathDirLink: Link = this.getDirLink(newPathSteps);
        if(!newPathDirLink) throwError('ENOENT', 'rename', oldPathFilename, newPathFilename);

        // TODO: Also treat cases with directories and symbolic links.
        // TODO: See: http://man7.org/linux/man-pages/man2/rename.2.html

        // Remove hard link from old folder.
        const oldLinkParent = link.parent;
        if(oldLinkParent) {
            oldLinkParent.deleteChild(link);
        }

        // Rename should overwrite the new path, if that exists.
        link.steps = newPathSteps;
        newPathDirLink.setChild(link.getName(), link);
    }

    renameSync(oldPath: TFilePath, newPath: TFilePath) {
        const oldPathFilename = pathToFilename(oldPath);
        const newPathFilename = pathToFilename(newPath);
        this.renameBase(oldPathFilename, newPathFilename);
    }

    rename(oldPath: TFilePath, newPath: TFilePath, callback: TCallback<void>) {
        const oldPathFilename = pathToFilename(oldPath);
        const newPathFilename = pathToFilename(newPath);
        this.wrapAsync(this.renameBase, [oldPathFilename, newPathFilename], callback);
    }

    private existsBase(filename: string): boolean {
        return !!this.statBase(filename);
    }

    existsSync(path: TFilePath): boolean {
        return this.existsBase(pathToFilename(path));
    }

    exists(path: TFilePath, callback: (exists: boolean) => void) {
        const filename = pathToFilename(path);

        if(typeof callback !== 'function')
            throw Error(ERRSTR.CB);

        setImmediate(() => {
            try {
                callback(this.existsBase(filename));
            } catch(err) {
                callback(false);
            }
        });
    }

    accessSync(path: TFilePath, mode: number = F_OK) {
        const filename = pathToFilename(path);

        const steps = filenameToSteps(filename);
        const node = this.getLink(steps);
        if(!node) throwError('ENOENT', 'access', filename);

        mode = mode | 0;
    }

/*

    normalize(somepath) {
        somepath = normalize(somepath);
        // Remove trailing slash.
        if(somepath[somepath.length - 1] == sep) somepath = somepath.substr(0, somepath.length - 1);
        return somepath;
    }

    addDir(fullpath: string, layer: Layer) {
        fullpath = this.normalize(fullpath);
        if(this.flattened[fullpath]) throw Error('Node already exists: ' + fullpath);

        let relativePath = relative(layer.mountpoint, fullpath);
        relativePath = relativePath.replace(/\\/g, '/'); // Always use forward slashed in our virtual relative paths.

        const directory = new Directory(relativePath, layer);
        this.flattened[fullpath] = directory;
        this.fds[directory.fd] = directory;
        return directory;
    }

    addFile(fullpath: string, layer: Layer) {
        fullpath = this.normalize(fullpath);
        if(this.flattened[fullpath]) throw Error('Node already exists: ' + fullpath);

        let relativePath = relative(layer.mountpoint, fullpath);
        relativePath = relativePath.replace(/\\/g, '/'); // Always use forward slashed in our virtual relative paths.
        var node = new File(relativePath, layer);

        this.flattened[fullpath] = node;
        this.fds[node.fd] = node;

        var steps = relativePath.split('/');
        var dirfullpath = layer.mountpoint;
        for(var i = 0; i < steps.length - 1; i++) {
            dirfullpath += sep + steps[i];
            var exists = !!this.flattened[fullpath];
            if(!exists) this.addDir(dirfullpath, layer);
        }

        return node;
    }

    addLayer(layer: Layer) {
        this.layers.push(layer);
        const mountpoint = resolve(layer.mountpoint) + sep;

        // Add the root dir at the mount point.
        this.addDir(mountpoint, layer);

        for(let relativePath in layer.files) {
            var filepath = relativePath.replace(/\//g, sep);
            var fullpath = mountpoint + filepath;
            this.addFile(fullpath, layer);
        }
    }

    getFilePath(p: string) {
        var filepath = resolve(p);
        var node = this.getNode(filepath);
        return node ? node : null;
    }

    getNode(p: string): Node {
        var filepath = resolve(p);
        var node = this.flattened[filepath];
        if(!node) throw this.err404(filepath);
        return node;
    }

    getFile(p: string): File {
        var node = this.getNode(p);
        if(node instanceof File) return node;

        throw this.err404(node.path);
    }

    getDirectory(p: string): Directory {
        var node = this.getNode(p);
        if(node instanceof Directory) return node;

        throw Error('Directory not found: ' + node.path);
    }

    getByFd(fd: number): Node {
        var node = this.fds[fd];
        if(node) return node;

        throw Error('Node file descriptor not found: ' + fd);
    }

    getLayerContainingPath(fullpath: string) {
        for(var i = 0; i < this.layers.length; i++) {
            var layer = this.layers[i];
            if(fullpath.indexOf(layer.mountpoint) === 0) return layer;
        }
        return null;
    }

    private err404(file) {
        return Error('File not found: ' + file);
    }

    /!**
     * Mount virtual in-memory files.
     * @param mountpoint Path to the root of the mounting point.
     * @param files A dictionary of relative file paths to their contents.
     *!/
    mountSync(mountpoint: string = '/', files: TLayerFiles = {}) {
        this.addLayer(new Layer(mountpoint, files));
    }

    // TODO: Mount from URL?
    // TODO: `mount('/usr/lib', 'http://example.com/volumes/usr/lib.json', callback)`
    // TODO: ...also cache that it has been loaded...
    mount(mountpoint: string, files: {[s: string] : string}|string, callback) {

    }



    // fs.readdirSync(path)
    readdirSync(p: string) {
        var fullpath = resolve(p);

        // Check the path points into at least one of the directories our layers are mounted to.
        var layer = this.getLayerContainingPath(fullpath);
        if(!layer) {
            throw Error('Directory not found: ' + fullpath);
        }

        // Check directory exists.
        try {
            var dir = this.getDirectory(fullpath);
        } catch(e) {
            throw Error(`ENOENT: no such file or directory, scandir '${fullpath}'`);
        }

        var len = fullpath.length;
        var index = {};
        for(var nodepath in this.flattened) {
            if(nodepath.indexOf(fullpath) === 0) { // Matches at the very beginning.
                try {
                    var node = this.getNode(nodepath);
                } catch(e) {
                    // This should never happen.
                    throw e;
                }

                let relativePath = nodepath.substr(len + 1);
                const sep_pos = relativePath.indexOf(sep);
                if(sep_pos > -1) relativePath = relativePath.substr(0, sep_pos);
                if(relativePath) index[relativePath] = 1;
            }
        }

        var files = [];
        for(var file in index) files.push(file);
        return files;
    }

    // fs.readdir(path, callback)
    readdir(p: string, callback) {
        setImmediate(() => {
            try {
                callback(null, this.readdirSync(p));
            } catch(e) {
                callback(e);
            }
        });
    }

    // fs.appendFileSync(filename, data[, options])
    appendFileSync(filename, data, options?) {
        try {
            var file = this.getFile(filename);
            file.setData(file.getData() + data.toString());
        } catch(e) { // Try to create a new file.
            var fullpath = resolve(filename);
            var layer = this.getLayerContainingPath(fullpath);
            if(!layer) throw Error('Cannot create new file at this path: ' + fullpath);
            var file = this.addFile(fullpath, layer);
            file.setData(data.toString());
        }
    }

    // fs.appendFile(filename, data[, options], callback)
    appendFile(filename, data, options, callback?) {
        if(typeof options == 'function') {
            callback = options;
            options = null;
        }

        setImmediate(() => {
            try {
                this.appendFileSync(filename, data, options);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.unlinkSync(path)
    unlinkSync(filename) {
        var node = this.getNode(filename);
        delete node.layer.files[node.relative];
        delete this.flattened[node.path];
        delete this.fds[node.fd];
    }

    // fs.unlink(path, callback)
    unlink(filename, callback) {
        setImmediate(() => {
            try {
                this.unlinkSync(filename);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.truncateSync(path, len)
    truncateSync(filename, len) {
        var file = this.getFile(filename);
        file.truncate(len);
    }

    // fs.truncate(path, len, callback)
    truncate(filename, len, callback) {
        setImmediate(() => {
            try {
                this.truncateSync(filename, len);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.ftruncateSync(fd, len)
    ftruncateSync(fd, len) {
        const node = this.getByFd(fd) as File;
        if(!(node instanceof File)) this.err404((node as Node).path);
        node.truncate(len);
    }

    // fs.ftruncate(fd, len, callback)
    ftruncate(fd, len, callback) {
        setImmediate(() => {
            try {
                this.ftruncateSync(fd, len);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.chownSync(path, uid, gid)
    chownSync(filename, uid, gid) {
        var node = this.getNode(filename);
        node.chown(uid, gid);
    }

    // fs.chown(path, uid, gid, callback)
    chown(filename, uid, gid, callback) {
        setImmediate(() => {
            try {
                this.chownSync(filename, uid, gid);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.fchownSync(fd, uid, gid)
    fchownSync(fd: number, uid: number, gid: number) {
        var node = this.getByFd(fd);
        node.chown(uid, gid);
    }

    // fs.fchown(fd, uid, gid, callback)
    fchown(fd: number, uid: number, gid: number, callback?) {
        setImmediate(() => {
            try {
                this.fchownSync(fd, uid, gid);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.lchownSync(path, uid, gid)
    lchownSync(filename, uid, gid) {
        this.chownSync(filename, uid, gid);
    }

    // fs.lchown(path, uid, gid, callback)
    lchown(filename, uid, gid, callback) {
        this.chown(filename, uid, gid, callback);
    }

    // fs.chmodSync(path, mode)
    chmodSync(filename: string, mode) {
        this.getNode(filename); // Does nothing, but throws if `filename` does not resolve to a node.
    }

    // fs.chmod(filename, mode, callback)
    chmod(filename: string, mode, callback?) {
        setImmediate(() => {
            try {
                this.chmodSync(filename, mode);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.fchmodSync(fd, mode)
    fchmodSync(fd: number, mode) {
        this.getByFd(fd);
    }

    // fs.fchmod(fd, mode, callback)
    fchmod(fd: number, mode, callback) {
        setImmediate(() => {
            try {
                this.fchmodSync(fd, mode);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.lchmodSync(path, mode)
    lchmodSync(filename, mode) {
        this.chmodSync(filename, mode);
    }

    // fs.lchmod(path, mode, callback)
    lchmod(filename, mode, callback) {
        this.chmod(filename, mode, callback);
    }

    // fs.rmdirSync(path)
    rmdirSync(p: string) {
        var dir = this.getDirectory(p);
        delete this.flattened[dir.path];
        delete this.fds[dir.fd];
    }

    // fs.rmdir(path, callback)
    rmdir(p: string, callback) {
        setImmediate(() => {
            try {
                this.rmdirSync(p);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }



    // fs.utimesSync(path, atime, mtime)
    utimesSync(filename: string, atime, mtime) {
        var node = this.getNode(filename);
        node.atime = atime;
        node.mtime = mtime;
    }

    // fs.utimes(path, atime, mtime, callback)
    utimes(filename: string, atime, mtime, callback?) {
        setImmediate(() => {
            try {
                callback(null, this.utimesSync(filename, atime, mtime));
            } catch(e) {
                callback(e);
            }
        });
    }

    // fs.futimesSync(fd, atime, mtime)
    futimesSync(fd: number, atime, mtime) {
        var node = this.getByFd(fd);
        node.atime = atime;
        node.mtime = mtime;
    }

    // fs.futimes(fd, atime, mtime, callback)
    futimes(fd, atime, mtime, callback) {
        setImmediate(() => {
            try {
                callback(null, this.futimesSync(fd, atime, mtime));
            } catch(e) {
                callback(e);
            }
        });
    }

    // fs.accessSync(path[, mode])
    accessSync(filename: string, mode?) {
        // fs.F_OK | fs.R_OK | fs.W_OK | fs.X_OK
        // Everything passes, as long as a node exists.
        this.getNode(filename);
    }

    // fs.access(path[, mode], callback)
    access(filename: string, mode, callback?) {
        if(typeof mode == 'function') {
            callback = mode;
            mode = 7; // fs.F_OK | fs.R_OK | fs.W_OK | fs.X_OK
        }
        setImmediate(() => {
            try {
                this.accessSync(filename, mode);
                callback();
            } catch(e) {
                callback(e);
            }
        });
    }

    // fs.closeSync(fd)
    closeSync(fd) {
        this.getNode(fd);
    }

    // fs.close(fd, callback)
    close(fd, callback) {
        setImmediate(() => {
            try {
                this.closeSync(fd);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.mkdirSync(path[, mode])
    mkdirSync(p: string, mode?) {
        var fullpath = resolve(p);
        var layer = this.getLayerContainingPath(fullpath);
        if(!layer) throw Error('Cannot create directory at this path: ' + fullpath);

        // Check if parent directory exists.
        try {
            var parent = dirname(fullpath);
            var dir = this.getDirectory(parent);
        } catch(e) {
            throw Error(`ENOENT: no such file or directory, mkdir '${fullpath}'`);
        }

        this.addDir(fullpath, layer);
    }

    // fs.mkdir(path[, mode], callback)
    mkdir(p: string, mode, callback?) {
        if(typeof mode == 'function') {
            callback = mode;
            mode = 511; // 0777
        }

        setImmediate(() => {
            try {
                this.mkdirSync(p, mode);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.writeSync(fd, data[, position[, encoding]])
    // fs.writeSync(fd, buffer, offset, length[, position])
    writeSync(fd: number, buffer, offset, length, position?);
    writeSync(fd: number, data, position?, encoding?) {
        var file: File = this.getByFd(fd) as File;
        if(!(file instanceof File)) throw Error('Is not a file: ' + (file as Node).path);

        if(!(data instanceof Buffer)) {
            // Docs: "If data is not a Buffer instance then the value will be coerced to a string."
            data = data.toString();
        } else { // typeof data is Buffer
            var buffer = data;
            var offset = position;
            var length = encoding;
            position = arguments[4];
            data = buffer.slice(offset, length);
            data = data.toString();
        }

        if(typeof position == 'undefined') position = file.position;

        var cont = file.getData();
        cont = cont.substr(0, position) + data + cont.substr(position + data.length);
        file.setData(cont);
        file.position = position + data.length;

        //return data.length;
        return Buffer.byteLength(data, encoding);
    }

    //fs.write(fd, data[, position[, encoding]], callback)
    //fs.write(fd, buffer, offset, length[, position], callback)
    write(fd: number, buffer, offset, length, position, callback?) {
        if(typeof position == 'function') {
            callback = position;
            position = void 0;
        }
        if(typeof length == 'function') {
            callback = length;
            length = position = void 0;
        }
        if(typeof offset == 'function') {
            callback = offset;
            offset = length = position = void 0;
        }

        setImmediate(() => {
            try {
                const bytes = this.writeSync(fd, buffer, offset, length, position);
                if(callback) callback(null, bytes);
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.readSync(fd, buffer, offset, length, position)
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
        // TODO: Node.js will read the file forever in `.creatReadStream` mode.
        // TODO: We need to generate new file descriptor `fd` for every new `openSync`
        // TODO: and track position in file for every `readSync` and then when we are at the EOF
        // TODO: we should return 0 (zero bytes read) so the stream closes.
        const file = this.getByFd(fd) as File;
        if(!(file instanceof File)) throw Error('Not a file: ' + (file as Node).path);
        var data = file.getData();
        if(position === null) position = file.position;
        var chunk = data.substr(position, length);
        buffer.write(chunk, offset, length);
        return chunk.length;
    }

    // fs.read(fd, buffer, offset, length, position, callback)
    read(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback) {
        setImmediate(() => {
            try {
                var bytes = this.readSync(fd, buffer, offset, length, position);
                callback(null, bytes, buffer);
            } catch(e) {
                callback(e);
            }
        });
    }

    // fs.linkSync(srcpath, dstpath)
    linkSync(srcpath, dstpath) {
        var node = this.getNode(srcpath);
        dstpath = resolve(dstpath);
        if(this.flattened[dstpath]) throw Error('Destination path already in use: ' + dstpath);
        this.flattened[dstpath] = node;
    }

    // fs.link(srcpath, dstpath, callback)
    link(srcpath, dstpath, callback) {
        setImmediate(() => {
            try {
                this.linkSync(srcpath, dstpath);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.symlinkSync(srcpath, dstpath[, type])
    symlinkSync(srcpath, dstpath, t?) {
        this.linkSync(srcpath, dstpath);
    }

    // fs.symlink(srcpath, dstpath[, type], callback)
    symlink(srcpath, dstpath, t, callback?) {
        if(typeof t == 'function') {
            callback = t;
            t = void 0;
        }
        this.link(srcpath, dstpath, callback);
    }

    // fs.readlinkSync(path)
    readlinkSync(p: string) {
        var node = this.getNode(p);
        return node.path;
    }

    // fs.readlink(path, callback)
    readlink(p: string, callback) {
        setImmediate(() => {
            try {
                callback(null, this.readlinkSync(p));
            } catch(e) {
                callback(e);
            }
        });
    }

    // fs.fsyncSync(fd)
    fsyncSync(fd: number) {
        this.getByFd(fd);
    }

    // fs.fsync(fd, callback)
    fsync(fd, callback) {
        setImmediate(() => {
            try {
                this.fsyncSync(fd);
                if(callback) callback();
            } catch(e) {
                if(callback) callback(e);
            }
        });
    }

    // fs.createReadStream(path[, options])
    createReadStream(p: string, options?) {
        options = options || {};
        var file = options.fd ? this.getByFd(options.fd) : this.getFile(p);
        if(!(file instanceof File)) throw Error('Not a file: ' + file.path);

        var util = require('util');
        var Readable = require('stream').Readable;
        var Buffer = require('buffer').Buffer;

        function MemFileReadStream(opt?) {
            Readable.call(this, opt);
            this.done = false;
        }
        util.inherits(MemFileReadStream, Readable);
        MemFileReadStream.prototype._read = function() {
            if(!this.done) {
                this.push(new Buffer(file.getData()));
                // this.push(null);
                this.done = true;
            } else {
                this.push(null);
            }
        };

        return new MemFileReadStream();
    }

    // fs.createWriteStream(path[, options])
    createWriteStream(p: string, options?) {
        options = options || {};
        const file = <File> (options.fd ? this.getByFd(options.fd) : this.getFile(p));
        if(!(file instanceof File)) throw Error('Not a file: ' + (file as Node).path);

        if(options.start) file.position = options.start;

        var util = require('util');
        var Writable = require('stream').Writable;
        var Buffer = require('buffer').Buffer;

        function MemFileWriteStream(opt?) {
            Writable.call(this, opt);
        }
        util.inherits(MemFileWriteStream, Writable);
        MemFileWriteStream.prototype._write = function(chunk) {
            chunk = chunk.toString();
            var cont = file.getData();
            cont = cont.substr(0, file.position) + chunk + cont.substr(file.position + chunk.length);
            file.setData(cont);
            file.position += chunk.length;
        };

        return new MemFileWriteStream();
    }

    //fs.watchFile(filename[, options], listener)
    //fs.unwatchFile(filename[, listener])
    //fs.watch(filename[, options][, listener])
    */
}
