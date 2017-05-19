var arnParser = {};

arnParser.parse = function (arn) {
    if (!arn) {
        return;
    }
    var match = arn.match(/(arn:aws:lambda:)?([a-z]{2}-[a-z]+-\d{1}:)?(\d{12}:)?(function:)?([a-zA-Z0-9-_]+)/);
    if (!match) {
        return;
    }
    var functionInfo = {
        "region": match[2] ? match[2].replace(":", "") : undefined,
        "accountId": match[3] ? match[3].replace(":", "") : undefined,
        "functionName": match[5]
    };
    return functionInfo;
};

module.exports = arnParser;