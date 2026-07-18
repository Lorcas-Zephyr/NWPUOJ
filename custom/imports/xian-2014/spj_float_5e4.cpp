#include <bits/stdc++.h>
using namespace std;

static string trimCR(string value) {
    if (!value.empty() && value.back() == '\r') value.pop_back();
    return value;
}

static bool parseLine(const string& line, int& id, double& value) {
    static const regex pattern(R"(^Case #([0-9]+): ([^ ]+)$)");
    smatch match;
    if (!regex_match(line, match, pattern)) return false;
    try {
        id = stoi(match[1].str());
        size_t used = 0;
        value = stod(match[2].str(), &used);
        return used == match[2].str().size() && isfinite(value);
    } catch (...) {
        return false;
    }
}

int main() {
    ifstream input("input"), user("user_out"), answer("answer");
    int tests = 0;
    input >> tests;
    string userLine, answerLine;
    bool accepted = true;

    for (int caseId = 1; caseId <= tests; ++caseId) {
        if (!getline(user, userLine) || !getline(answer, answerLine)) {
            accepted = false;
            break;
        }
        userLine = trimCR(userLine);
        answerLine = trimCR(answerLine);
        int userId = 0, answerId = 0;
        double userValue = 0, answerValue = 0;
        if (!parseLine(userLine, userId, userValue) ||
            !parseLine(answerLine, answerId, answerValue) ||
            userId != answerId || fabs(userValue - answerValue) > 5e-4) {
            accepted = false;
            break;
        }
    }

    string extra;
    while (accepted && getline(user, extra)) {
        if (extra.find_first_not_of(" \t\r") != string::npos) accepted = false;
    }
    cout << (accepted ? 100 : 0) << '\n';
    cerr << (accepted ? "Accepted" : "Wrong answer") << '\n';
}
