/**
 * @fileoverview This module provides a constructor for an ftp server
 * user manager operating on top of an object containing the user accounts.
 */

addToClasspath("../jars/ftplet-api-1.0.6.jar");
addToClasspath("../jars/ftpserver-core-1.0.6.jar");

var fs = require("fs");
var {AuthenticationFailedException} = org.apache.ftpserver.ftplet;
var {Md5PasswordEncryptor, SaltedPasswordEncryptor, ClearTextPasswordEncryptor} =
        org.apache.ftpserver.usermanager;
var {BaseUser, WritePermission, ConcurrentLoginPermission,
        TransferRatePermission} = org.apache.ftpserver.usermanager.impl;
var {UsernamePasswordAuthentication, AnonymousAuthentication} =
        org.apache.ftpserver.usermanager;
var FtpletUserManager = org.apache.ftpserver.ftplet.UserManager;
var {IllegalArgumentException} = java.lang;
var {ArrayList} = java.util;
var {EventEmitter} = require("ringo/events");

/**
 * Encrypts the password passed as argument.
 * @param {String} password The password to encrypt
 * @returns {String} The encrypted password
 */
exports.encryptPassword = function(password) {
    var encryptor = new SaltedPasswordEncryptor();
    return encryptor.encrypt(password);
};

/**
 * Returns a new UserManager instance
 * @class Instances of this class represent a usermanager operating on
 * a hash of user accounts.
 * @param {Object} users An object with properties for each user containing
 * at least the name, password and homeDirectory.
 * @returns {UserManager} A newly constructed user manager
 * @constructor
 */
var UserManager = exports.UserManager = function(users) {

    var adminName = "admin";
    EventEmitter.call(this);

    Object.defineProperties(this, {

        /**
         * An object containing the user accounts
         * @type Object
         */
        "users": {
            "get": function() {
                return users || {};
            },
            "enumerable": true,
            "configurable": true
        },

        /**
         * Returns the name of the admin account (default: `admin`)
         * @returns {String} The name of the admin account
         */
        "getAdminName": {
            "value": function() {
                return adminName;
            },
            "enumerable": true,
            "configurable": true
        },

        /**
         * Sets the admin name to the one passed as argument
         * @param {String} name The name of the admin account
         */
        "setAdminName": {
            "value": function(name) {
                adminName = name;
                return;
            },
            "enumerable": true,
            "configurable": true
        },

        /**
         * Loads the users from the JSON file. This method triggers a "reloaded"
         * event on this usermanager instance.
         * @param {Object} obj An object containing the user accounts
         */
        "loadUsers": {
            "value": sync(function(obj) {
                if (!obj || typeof(obj) !== "object" || obj.constructor !== Object) {
                    throw new Error("loadUsers expects an object as argument");
                }
                users = obj;
                this.emit("reloaded");
            }, this),
            "enumerable": true,
            "writable": true
        }

    });

    return this;
};

/**
 * Convenience method for creating a UserManager instance suitable for
 * use with ftpserver module.
 * @param {Object} obj An object containing the user accounts
 * @returns {org.apache.ftpserver.ftplet.UserManager} The user manager instance
 */
UserManager.create = function(obj) {
    return new FtpletUserManager(new UserManager(obj));
};

Object.defineProperties(UserManager.prototype, {

    /**
     * The encryptor used by this user manager
     * @type org.apache.ftpserver.usermanager.SaltedPasswordEncryptor
     */
    "encryptor": {
        "value": new SaltedPasswordEncryptor(),
        "enumerable": true
    }

});



/**
 * Authenticates against the user accounts of this manager
 * @param {UsernamePasswordAuthentication|AnonymousAuthentication} authentication The
 * authentication request to verify.
 * @returns {BaseUser} If authentication was successful, this method returns the
 * user object, otherwise it throws an AuthenticationFailedException
 */
UserManager.prototype.authenticate = function(authentication) {
    if (authentication instanceof UsernamePasswordAuthentication) {
        var username = authentication.getUsername();
        var password = authentication.getPassword() || "";
        if (username == null || !this.doesExist(username)) {
            throw new AuthenticationFailedException("Authentication failed");
        }
        var user = this.getUserByName(username);
        if (this.encryptor.matches(password, user.getPassword())) {
            return user;
        } else {
            throw new AuthenticationFailedException("Authentication failed");
        }
    } else if (authentication instanceof AnonymousAuthentication) {
        if (this.doesExist("anonymous")) {
            return this.getUserByName("anonymous");
        } else {
            throw new AuthenticationFailedException("Authentication failed");
        }
    } else {
        throw new IllegalArgumentException("Authentication not supported by this user manager");
    }
};

/**
 * Removes the user with the given name from the underlying users object
 * @param {String} username The name of the user to remove
 */
UserManager.prototype["delete"] =   function(username) {
    if (this.doesExist(username)) {
        delete this.users[username];
    }
};

/**
 * Returns true if this manager has a user with the given username
 * @param {String} username The username to check if existing
 * @returns {Boolean} True if the user exists, false otherwise
 */
UserManager.prototype.doesExist = function(username) {
    return this.users.hasOwnProperty(username);
};

/**
 * Returns an array containing all user names known to this manager
 * @returns {Array} An array containing all user names
 */
UserManager.prototype.getAllUserNames = function() {
    return Object.keys(this.users);
};

/**
 * Returns the user with the given name
 * @param {String} username The user name
 * @returns {User} The user object, or null if the user doesn't exist
 */
UserManager.prototype.getUserByName = function(username) {
    if (!this.doesExist(username)) {
        return null;
    }
    var props = this.users[username];
    var user = new BaseUser();
    user.setName(props.name);
    user.setPassword(props.password);
    user.setHomeDirectory(props.homeDirectory);
    user.setEnabled(props.isEnabled === true);
    var authorities = new ArrayList();
    if (props.canWrite !== false) {
        authorities.add(new WritePermission());
    }
    authorities.add(new ConcurrentLoginPermission(props.maxLogin || 0,
            props.maxLoginPerIp || 0));
    authorities.add(new TransferRatePermission(props.downloadRate || 0,
            props.uploadRate || 0));
    user.setAuthorities(authorities);
    user.setMaxIdleTime(props.maxIdleTime || 0);
    return user;
};

/**
 * Returns true if the user name passed as argument equals the admin account name.
 * @param {String} username The user name
 * @returns {Boolean} True if the user name equals the admin name, false otherwise
 */
UserManager.prototype.isAdmin = function(username) {
    return username === this.getAdminName();
};

/**
 * Adds the user to the list of accounts, possibly replacing an already
 * existing account with the same name.
 * @param {Object} user The user account data
 */
UserManager.prototype.save = function(user) {
    if (user.name == null || typeof(user.name) !== "string") {
        throw new Error("User name is null or not a string");
    }
    this.users[user.name] = user;
};
