#include <bits/stdc++.h>
using namespace std;

static string readLine(ifstream& stream) {
    string value;
    getline(stream, value);
    if (!value.empty() && value.back() == '\r') value.pop_back();
    return value;
}

static bool readCaseHeader(ifstream& stream, int expected) {
    string line = readLine(stream);
    return line == "Case #" + to_string(expected) + ":";
}

static bool readCount(ifstream& stream, int& count) {
    string line = readLine(stream);
    static const regex pattern(R"(^[0-9]+$)");
    if (!regex_match(line, pattern)) return false;
    try {
        count = stoi(line);
        return count >= 0;
    } catch (...) {
        return false;
    }
}

int main() {
    ifstream input("input"), user("user_out"), answer("answer");
    int tests = 0;
    input >> tests;
    bool accepted = true;

    for (int caseId = 1; accepted && caseId <= tests; ++caseId) {
        if (!readCaseHeader(answer, caseId) || !readCaseHeader(user, caseId)) {
            accepted = false;
            break;
        }
        int answerCount = 0, userCount = 0;
        if (!readCount(answer, answerCount) || !readCount(user, userCount) ||
            answerCount != userCount) {
            accepted = false;
            break;
        }
        vector<string> expected, actual;
        for (int i = 0; i < answerCount; ++i) expected.push_back(readLine(answer));
        for (int i = 0; i < userCount; ++i) actual.push_back(readLine(user));
        sort(expected.begin(), expected.end());
        sort(actual.begin(), actual.end());
        if (expected != actual) accepted = false;
    }

    string extra;
    while (accepted && getline(user, extra)) {
        if (extra.find_first_not_of(" \t\r") != string::npos) accepted = false;
    }
    cout << (accepted ? 100 : 0) << '\n';
    cerr << (accepted ? "Accepted" : "Wrong answer") << '\n';
}
