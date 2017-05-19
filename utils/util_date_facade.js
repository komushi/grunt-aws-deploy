'use strict';

var dateFacade = {};

dateFacade.getFormattedTimestamp = function (dateObject) {
    var time_components = [
        dateObject.getFullYear(),
        dateObject.getMonth(),
        dateObject.getDate(),
        dateObject.getHours(),
        dateObject.getMinutes(),
        dateObject.getSeconds()
    ];
    return time_components.join('-');
};

dateFacade.getHumanReadableTimestamp = function (dateObject) {
    return dateObject.toLocaleString();
};

module.exports = dateFacade;