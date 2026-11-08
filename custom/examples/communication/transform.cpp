#include <fstream>
#include <iostream>
#include <string>

int main() {
    long long value;
    std::string extra;
    if (!(std::cin >> value) || (std::cin >> extra)) {
        std::cerr << "Round 1 must output exactly one integer.\n";
        return 2; // Presentation Error
    }
    int phase;
    long long a, b;
    std::ifstream original("input");
    if (!(original >> phase >> a >> b)) {
        std::cerr << "Invalid test input.\n";
        return 3; // Judgement Failed: problem data error
    }
    if (value != a + b) {
        std::cerr << "Round 1 sent the wrong sum.\n";
        return 1; // Wrong Answer
    }
    std::cout << "2\n" << value << '\n';
    return 0;
}
